/**
 * Local in-plugin WebAssembly Speech-to-Text powered by Oído (`lokutor-ai/oido`).
 *
 * - Runs Oído's 67 KB Conformer-CTC C engine compiled to WebAssembly (`oido.wasm`).
 * - Loads bundled `oido_v2.tlm` + `oido_v2a.tnm` / `oido_v2b.tnm` directly from
 *   SiYuan's `/api/file/getFile` (100% offline, zero downloads).
 * - Starts WebAudio capture (`AudioContext` + `AnalyserNode` + `ScriptProcessorNode`)
 *   and live 60fps waveform IMMEDIATELY inside the user's click gesture so AudioContext
 *   is never suspended and words stream into the textbox as soon as they are decoded.
 */

export type SttState = "idle" | "recording" | "loading-model" | "transcribing";

export interface SttStatusUpdate {
    state: SttState;
    message?: string;
}

export interface SttSessionCallbacks {
    /** "oido_v2a" (accurate, default) or "oido_v2b" (ultra-low latency) */
    modelId?: string;
    canvas?: HTMLCanvasElement | null;
    /** Called continuously with the cumulative decoded text of the current utterance as words are spoken */
    onPartial: (text: string) => void;
    /** Called once when stopped with the final refined text of the utterance */
    onFinal?: (text: string) => void;
    onStatus?: (update: SttStatusUpdate) => void;
    onError?: (err: Error) => void;
}

interface OidoWasmInstance {
    HEAPU8: Uint8Array;
    HEAP16: Int16Array;
    UTF8ToString(ptr: number): string;
    _oido_alloc(n: number): number;
    _oido_free(ptr: number): void;
    _oido_unload(): void;
    _oido_load(modelPtr: number, mlen: number, lmPtr: number, llen: number, beam: number, topk: number): number;
    _oido_reset(): void;
    _oido_feed(pcmPtr: number, n: number): number;
    _oido_partial(): number;
    _oido_finish(): number;
}

interface OidoVariant {
    file: string;
    beam: number;
    topk: number;
    label: string;
}

const PLUGIN_NAME = "siyuan-learnharness";
const WASM_REL_PATH = "oido/oido.wasm";
const MODELS_REL_BASE = "oido/models/";
const TARGET_SAMPLE_RATE = 16000;
const FEED_CHUNK_SAMPLES = 3200; // 200ms at 16kHz for snappy real-time streaming

const OIDO_VARIANTS: Record<string, OidoVariant> = {
    oido_v2a: { file: "oido_v2a.tnm", beam: 4, topk: 6, label: "Oído v2a" },
    oido_v2b: { file: "oido_v2b.tnm", beam: 2, topk: 3, label: "Oído v2b" },
};

function resolveVariantKey(modelId?: string): "oido_v2a" | "oido_v2b" {
    return modelId === "oido_v2b" ? "oido_v2b" : "oido_v2a";
}

function downsampleFloatToInt16(input: Float32Array, inputRate: number): Int16Array {
    if (inputRate === TARGET_SAMPLE_RATE) {
        const out = new Int16Array(input.length);
        for (let i = 0; i < input.length; i++) {
            out[i] = Math.max(-32768, Math.min(32767, Math.round(input[i]! * 32768)));
        }
        return out;
    }
    const ratio = inputRate / TARGET_SAMPLE_RATE;
    const outLength = Math.max(1, Math.floor(input.length / ratio));
    const out = new Int16Array(outLength);
    for (let i = 0; i < outLength; i++) {
        const start = Math.floor(i * ratio);
        const end = Math.min(input.length, Math.floor((i + 1) * ratio));
        let sum = 0;
        let count = 0;
        for (let j = start; j < end; j++) {
            sum += input[j]!;
            count++;
        }
        const sample = count > 0 ? sum / count : input[start] ?? 0;
        out[i] = Math.max(-32768, Math.min(32767, Math.round(sample * 32768)));
    }
    return out;
}

class LocalOidoSttService {
    private mod: OidoWasmInstance | null = null;
    private loadedVariant: string | null = null;
    private loadingPromise: Promise<void> | null = null;
    private engineReadyForSession = false;

    private modelPtr = 0;
    private lmPtr = 0;
    private pcmPtr = 0;
    private pcmCap = 0;
    private lmBytesCache: ArrayBuffer | null = null;
    private modelBytesCache = new Map<string, ArrayBuffer>();

    private recording = false;
    private mediaStream: MediaStream | null = null;
    private audioCtx: AudioContext | null = null;
    private analyser: AnalyserNode | null = null;
    private processor: ScriptProcessorNode | null = null;
    private sourceNode: MediaStreamAudioSourceNode | null = null;
    private silentGain: GainNode | null = null;
    private rafId: number | null = null;

    private pcmAccum: Int16Array[] = [];
    private pcmAccumLen = 0;
    private lastPartialText = "";
    private activeCallbacks: SttSessionCallbacks | null = null;

    public isRecording(): boolean {
        return this.recording;
    }

    /** Start live microphone capture, waveform rendering, and real-time Oído streaming transcription. */
    public async startLiveSession(callbacks: SttSessionCallbacks): Promise<void> {
        if (this.recording) return;
        if (!navigator.mediaDevices?.getUserMedia) {
            throw new Error("Microphone access is not available in this environment.");
        }

        const variantKey = resolveVariantKey(callbacks.modelId);
        this.activeCallbacks = callbacks;
        this.pcmAccum = [];
        this.pcmAccumLen = 0;
        this.lastPartialText = "";
        this.engineReadyForSession = false;

        // 1. Create & resume AudioContext IMMEDIATELY inside the click gesture so it is never suspended
        const AudioCtx = window.AudioContext || (window as any).webkitAudioContext;
        const audioCtx = new AudioCtx() as AudioContext;
        this.audioCtx = audioCtx;
        if (audioCtx.state === "suspended") {
            await audioCtx.resume();
        }

        // 2. Capture microphone immediately and start the live waveform right away
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        this.mediaStream = stream;

        const source = audioCtx.createMediaStreamSource(stream);
        this.sourceNode = source;

        const analyser = audioCtx.createAnalyser();
        analyser.fftSize = 128;
        analyser.smoothingTimeConstant = 0.7;
        this.analyser = analyser;

        const processor = audioCtx.createScriptProcessor(4096, 1, 1);
        this.processor = processor;

        // Silent gain node keeps ScriptProcessorNode active in Chromium without playing mic echo
        const silentGain = audioCtx.createGain();
        silentGain.gain.value = 0;
        this.silentGain = silentGain;

        source.connect(analyser);
        analyser.connect(processor);
        processor.connect(silentGain);
        silentGain.connect(audioCtx.destination);

        const inputRate = audioCtx.sampleRate;

        processor.onaudioprocess = (ev) => {
            if (!this.recording) return;
            const raw = ev.inputBuffer.getChannelData(0);
            const pcm16 = downsampleFloatToInt16(raw, inputRate);
            this.pcmAccum.push(pcm16);
            this.pcmAccumLen += pcm16.length;

            if (this.engineReadyForSession && this.mod && this.pcmAccumLen >= FEED_CHUNK_SAMPLES) {
                this.feedAccumulatedPcm();
            }
        };

        this.recording = true;
        if (callbacks.canvas) {
            this.startWaveformLoop(callbacks.canvas);
        }

        // 3. Load Oído WASM + bundled models (buffered speech is fed immediately once ready)
        try {
            await this.ensureLoaded(variantKey, callbacks.onStatus);
            if (!this.recording || !this.mod) return;
            this.mod._oido_reset();
            this.engineReadyForSession = true;
            callbacks.onStatus?.({ state: "recording", message: "Listening (Oído)..." });
            if (this.pcmAccumLen > 0) {
                this.feedAccumulatedPcm();
            }
        } catch (err) {
            const error = err instanceof Error ? err : new Error(String(err));
            console.error("[LearnHarness Oído] Load failed:", error);
            await this.stopLiveSession();
            throw error;
        }
    }

    /** Stop recording, flush any remaining PCM, and finalize the Oído transcript. */
    public async stopLiveSession(): Promise<string> {
        if (!this.recording) return this.lastPartialText;
        this.recording = false;

        if (this.rafId !== null) {
            cancelAnimationFrame(this.rafId);
            this.rafId = null;
        }

        try {
            this.processor?.disconnect();
            this.analyser?.disconnect();
            this.sourceNode?.disconnect();
            this.silentGain?.disconnect();
        } catch {
            // ignore
        }
        this.mediaStream?.getTracks().forEach((t) => t.stop());
        void this.audioCtx?.close().catch(() => {});

        this.processor = null;
        this.analyser = null;
        this.sourceNode = null;
        this.silentGain = null;
        this.mediaStream = null;
        this.audioCtx = null;

        const cb = this.activeCallbacks;
        let finalText = this.lastPartialText;

        if (this.engineReadyForSession && this.mod) {
            if (this.pcmAccumLen > 0) {
                this.feedAccumulatedPcm();
            }
            const rawFinal = this.mod.UTF8ToString(this.mod._oido_finish()).trim();
            if (rawFinal) {
                finalText = rawFinal;
                this.lastPartialText = rawFinal;
            }
        } else {
            this.pcmAccum = [];
            this.pcmAccumLen = 0;
        }

        this.engineReadyForSession = false;
        if (finalText) {
            cb?.onFinal?.(finalText);
        }
        cb?.onStatus?.({ state: "idle" });
        this.activeCallbacks = null;
        return finalText;
    }

    private feedAccumulatedPcm(): void {
        if (!this.mod || this.pcmAccumLen === 0) return;
        const merged = new Int16Array(this.pcmAccumLen);
        let offset = 0;
        for (const chunk of this.pcmAccum) {
            merged.set(chunk, offset);
            offset += chunk.length;
        }
        this.pcmAccum = [];
        this.pcmAccumLen = 0;

        const ptr = this.ensurePcmBuffer(merged.length);
        this.mod.HEAP16.set(merged, ptr >> 1);
        this.mod._oido_feed(ptr, merged.length);

        const partial = this.mod.UTF8ToString(this.mod._oido_partial()).trim();
        if (partial && partial !== this.lastPartialText) {
            this.lastPartialText = partial;
            this.activeCallbacks?.onPartial(partial);
        }
    }

    private ensurePcmBuffer(samples: number): number {
        const m = this.mod!;
        if (samples > this.pcmCap) {
            if (this.pcmPtr) m._oido_free(this.pcmPtr);
            this.pcmCap = Math.max(samples, 16000);
            this.pcmPtr = m._oido_alloc(this.pcmCap * 2);
        }
        return this.pcmPtr;
    }

    private allocAndCopy(bytes: ArrayBuffer): number {
        const m = this.mod!;
        const p = m._oido_alloc(bytes.byteLength);
        m.HEAPU8.set(new Uint8Array(bytes), p);
        return p;
    }

    private async ensureLoaded(
        variantKey: "oido_v2a" | "oido_v2b",
        onStatus?: (update: SttStatusUpdate) => void,
    ): Promise<void> {
        if (this.mod && this.loadedVariant === variantKey) return;
        if (this.loadingPromise && this.loadedVariant === variantKey) {
            await this.loadingPromise;
            return;
        }

        const variant = OIDO_VARIANTS[variantKey]!;
        this.loadedVariant = variantKey;

        this.loadingPromise = (async () => {
            if (!this.mod) {
                onStatus?.({ state: "loading-model", message: "Loading Oído WASM..." });
                const wasmBinary = await this.fetchLocalAsset(WASM_REL_PATH, "Oído WASM engine");
                const magic = new Uint8Array(wasmBinary, 0, Math.min(4, wasmBinary.byteLength));
                if (
                    magic.length < 4 ||
                    magic[0] !== 0x00 ||
                    magic[1] !== 0x61 ||
                    magic[2] !== 0x73 ||
                    magic[3] !== 0x6d
                ) {
                    throw new Error(`Invalid oido.wasm binary (${wasmBinary.byteLength} bytes).`);
                }
                // eslint-disable-next-line @typescript-eslint/no-require-imports
                const OidoModuleFactory = require("../assets/oido/oido.js") as (
                    arg?: Record<string, unknown>,
                ) => Promise<OidoWasmInstance>;

                this.mod = await new Promise<OidoWasmInstance>((resolve, reject) => {
                    OidoModuleFactory({
                        instantiateWasm: (
                            imports: WebAssembly.Imports,
                            receive: (instance: WebAssembly.Instance) => void,
                        ) => {
                            WebAssembly.instantiate(wasmBinary, imports)
                                .then((res) => receive(res.instance))
                                .catch((err) => reject(err));
                            return {};
                        },
                    })
                        .then(resolve)
                        .catch(reject);
                });
            }

            if (!this.lmBytesCache) {
                onStatus?.({ state: "loading-model", message: "Loading Oído language model..." });
                this.lmBytesCache = await this.fetchLocalAsset(
                    `${MODELS_REL_BASE}oido_v2.tlm`,
                    "Oído language model",
                );
            }
            let modelBytes = this.modelBytesCache.get(variantKey);
            if (!modelBytes) {
                onStatus?.({ state: "loading-model", message: `Loading ${variant.label}...` });
                modelBytes = await this.fetchLocalAsset(
                    `${MODELS_REL_BASE}${variant.file}`,
                    variant.label,
                );
                this.modelBytesCache.set(variantKey, modelBytes);
            }

            onStatus?.({ state: "loading-model", message: `Initializing ${variant.label}...` });
            this.mod._oido_unload();
            if (this.modelPtr) this.mod._oido_free(this.modelPtr);
            if (this.lmPtr) this.mod._oido_free(this.lmPtr);

            this.modelPtr = this.allocAndCopy(modelBytes);
            this.lmPtr = this.allocAndCopy(this.lmBytesCache);

            const rc = this.mod._oido_load(
                this.modelPtr,
                modelBytes.byteLength,
                this.lmPtr,
                this.lmBytesCache.byteLength,
                variant.beam,
                variant.topk,
            );
            if (rc !== 0) {
                throw new Error(`Oído model load failed (rc=${rc}).`);
            }
        })();

        try {
            await this.loadingPromise;
        } catch (err) {
            this.loadedVariant = null;
            throw err;
        } finally {
            this.loadingPromise = null;
        }
    }

    private async fetchLocalAsset(relPath: string, label: string): Promise<ArrayBuffer> {
        const workspacePath = `/data/plugins/${PLUGIN_NAME}/${relPath}`;
        try {
            const apiRes = await fetch("/api/file/getFile", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ path: workspacePath }),
            });
            if (apiRes.ok) {
                const contentType = apiRes.headers.get("content-type") || "";
                const buf = await apiRes.arrayBuffer();
                if (buf.byteLength > 0 && !contentType.includes("application/json")) {
                    return buf;
                }
            }
        } catch {
            // fall through to static plugin path
        }

        const staticRes = await fetch(`/plugins/${PLUGIN_NAME}/${relPath}`);
        if (staticRes.ok) {
            const buf = await staticRes.arrayBuffer();
            if (buf.byteLength > 0) {
                return buf;
            }
        }

        throw new Error(`Could not load bundled ${label} (${workspacePath}).`);
    }

    private startWaveformLoop(canvas: HTMLCanvasElement): void {
        const ctx = canvas.getContext("2d");
        if (!ctx) return;

        const bins = new Uint8Array(this.analyser ? this.analyser.frequencyBinCount : 64);

        const draw = () => {
            if (!this.recording || !this.analyser) return;
            this.rafId = requestAnimationFrame(draw);

            const dpr = window.devicePixelRatio || 1;
            const rect = canvas.getBoundingClientRect();
            const w = Math.max(80, Math.floor(rect.width || canvas.clientWidth || 160));
            const h = Math.max(20, Math.floor(rect.height || canvas.clientHeight || 24));
            if (canvas.width !== Math.floor(w * dpr) || canvas.height !== Math.floor(h * dpr)) {
                canvas.width = Math.floor(w * dpr);
                canvas.height = Math.floor(h * dpr);
            }
            ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
            ctx.clearRect(0, 0, w, h);

            this.analyser.getByteFrequencyData(bins);
            const barCount = Math.max(16, Math.min(36, Math.floor(w / 5)));
            const gap = 2;
            const barW = Math.max(2, (w - gap * (barCount - 1)) / barCount);

            ctx.fillStyle = "#ef4444";

            for (let i = 0; i < barCount; i++) {
                const binIdx = Math.min(bins.length - 1, Math.floor((i / barCount) * (bins.length * 0.65)));
                // Boost low-to-mid speaking amplitudes so waveform visibly reacts
                const norm = Math.min(1, ((bins[binIdx] ?? 0) / 255) * 1.6);
                const barH = Math.max(3, norm * (h - 4));
                const x = i * (barW + gap);
                const y = (h - barH) / 2;
                ctx.fillRect(x, y, barW, barH);
            }
        };

        this.rafId = requestAnimationFrame(draw);
    }
}

export const localStt = new LocalOidoSttService();
