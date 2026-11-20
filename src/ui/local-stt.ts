/**
 * Local in-browser / in-Electron Speech-to-Text (`LocalSttService`).
 *
 * - Captures raw PCM audio via WebAudio (`AudioContext` + `AnalyserNode` + `ScriptProcessorNode`)
 *   so we get both a live 60fps waveform AND continuous 16kHz mono Float32 chunks.
 * - Preloads the quantized `@huggingface/transformers` model in the background the moment
 *   recording starts.
 * - Detects natural speech pauses (~650ms) or 4.5s max segments and transcribes incrementally
 *   in a serialized queue so words appear as soon as they are spoken.
 */

export type SttState = "idle" | "recording" | "loading-model" | "transcribing";

export interface SttStatusUpdate {
    state: SttState;
    message?: string;
}

export interface SttSessionCallbacks {
    modelId?: string;
    canvas?: HTMLCanvasElement | null;
    onTranscript: (text: string) => void;
    onStatus?: (update: SttStatusUpdate) => void;
    onError?: (err: Error) => void;
}

const DEFAULT_STT_MODEL = "onnx-community/moonshine-tiny-ONNX";
const TARGET_SAMPLE_RATE = 16000;
const SILENCE_THRESHOLD = 0.012;
const PAUSE_FLUSH_MS = 450;
const MAX_SEGMENT_SECONDS = 3.0;
const MIN_SEGMENT_SECONDS = 0.25;

function downsampleTo16k(input: Float32Array, inputRate: number): Float32Array {
    if (inputRate === TARGET_SAMPLE_RATE) return input;
    const ratio = inputRate / TARGET_SAMPLE_RATE;
    const outLength = Math.max(1, Math.floor(input.length / ratio));
    const out = new Float32Array(outLength);
    for (let i = 0; i < outLength; i++) {
        const start = Math.floor(i * ratio);
        const end = Math.min(input.length, Math.floor((i + 1) * ratio));
        let sum = 0;
        let count = 0;
        for (let j = start; j < end; j++) {
            sum += input[j]!;
            count++;
        }
        out[i] = count > 0 ? sum / count : input[start] ?? 0;
    }
    return out;
}

class LocalSttService {
    private transcriber: ((audio: Float32Array) => Promise<{ text?: string } | Array<{ text?: string }>>) | null = null;
    private loadedModelId: string | null = null;
    private loadingPromise: Promise<void> | null = null;

    private recording = false;
    private mediaStream: MediaStream | null = null;
    private audioCtx: AudioContext | null = null;
    private analyser: AnalyserNode | null = null;
    private processor: ScriptProcessorNode | null = null;
    private sourceNode: MediaStreamAudioSourceNode | null = null;
    private rafId: number | null = null;

    private pendingChunks: Float32Array[] = [];
    private pendingSampleCount = 0;
    private hasSpokenInSegment = false;
    private lastSpeechTime = 0;

    private queue: Promise<void> = Promise.resolve();
    private activeCallbacks: SttSessionCallbacks | null = null;
    private activeModelId: string = DEFAULT_STT_MODEL;

    public isRecording(): boolean {
        return this.recording;
    }

    /** Start live microphone capture, waveform rendering, and incremental transcription. */
    public async startLiveSession(callbacks: SttSessionCallbacks): Promise<void> {
        if (this.recording) return;
        if (!navigator.mediaDevices?.getUserMedia) {
            throw new Error("Microphone access is not available in this environment.");
        }

        this.activeCallbacks = callbacks;
        this.activeModelId = callbacks.modelId || DEFAULT_STT_MODEL;
        this.pendingChunks = [];
        this.pendingSampleCount = 0;
        this.hasSpokenInSegment = false;
        this.lastSpeechTime = performance.now();

        // Warm up / preload model immediately while user begins speaking
        void this.ensureModelLoaded(this.activeModelId, callbacks.onStatus).catch((err) => {
            callbacks.onError?.(err instanceof Error ? err : new Error(String(err)));
        });

        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        this.mediaStream = stream;

        const AudioCtx = window.AudioContext || (window as any).webkitAudioContext;
        const audioCtx = new AudioCtx() as AudioContext;
        this.audioCtx = audioCtx;

        const source = audioCtx.createMediaStreamSource(stream);
        this.sourceNode = source;

        const analyser = audioCtx.createAnalyser();
        analyser.fftSize = 128;
        analyser.smoothingTimeConstant = 0.75;
        this.analyser = analyser;

        const processor = audioCtx.createScriptProcessor(4096, 1, 1);
        this.processor = processor;

        source.connect(analyser);
        analyser.connect(processor);
        processor.connect(audioCtx.destination);

        const inputRate = audioCtx.sampleRate;
        const maxSamples = Math.floor(TARGET_SAMPLE_RATE * MAX_SEGMENT_SECONDS);
        const minSamples = Math.floor(TARGET_SAMPLE_RATE * MIN_SEGMENT_SECONDS);

        processor.onaudioprocess = (ev) => {
            if (!this.recording) return;
            const raw = ev.inputBuffer.getChannelData(0);
            let sumSq = 0;
            for (let i = 0; i < raw.length; i++) {
                const v = raw[i]!;
                sumSq += v * v;
            }
            const rms = Math.sqrt(sumSq / raw.length);
            const now = performance.now();

            if (rms >= SILENCE_THRESHOLD) {
                this.hasSpokenInSegment = true;
                this.lastSpeechTime = now;
            }

            if (this.hasSpokenInSegment || rms >= SILENCE_THRESHOLD * 0.6) {
                const down = downsampleTo16k(raw, inputRate);
                this.pendingChunks.push(down);
                this.pendingSampleCount += down.length;
            }

            const pausedLongEnough =
                this.hasSpokenInSegment &&
                now - this.lastSpeechTime >= PAUSE_FLUSH_MS &&
                this.pendingSampleCount >= minSamples;
            const hitMaxDuration = this.pendingSampleCount >= maxSamples;

            if (pausedLongEnough || hitMaxDuration) {
                this.flushPendingSegment();
            }
        };

        this.recording = true;
        callbacks.onStatus?.({ state: "recording", message: "Listening..." });

        if (callbacks.canvas) {
            this.startWaveformLoop(callbacks.canvas);
        }
    }

    /** Stop recording and flush any remaining spoken audio. */
    public async stopLiveSession(): Promise<void> {
        if (!this.recording) return;
        this.recording = false;

        if (this.rafId !== null) {
            cancelAnimationFrame(this.rafId);
            this.rafId = null;
        }

        try {
            this.processor?.disconnect();
            this.analyser?.disconnect();
            this.sourceNode?.disconnect();
        } catch {
            // ignore
        }
        this.mediaStream?.getTracks().forEach((t) => t.stop());
        void this.audioCtx?.close().catch(() => {});

        this.processor = null;
        this.analyser = null;
        this.sourceNode = null;
        this.mediaStream = null;
        this.audioCtx = null;

        if (this.pendingSampleCount >= Math.floor(TARGET_SAMPLE_RATE * 0.2)) {
            this.flushPendingSegment();
        } else {
            this.pendingChunks = [];
            this.pendingSampleCount = 0;
        }

        const cb = this.activeCallbacks;
        await this.queue;
        cb?.onStatus?.({ state: "idle" });
        this.activeCallbacks = null;
    }

    private flushPendingSegment(): void {
        if (this.pendingSampleCount === 0) return;
        const merged = new Float32Array(this.pendingSampleCount);
        let offset = 0;
        for (const chunk of this.pendingChunks) {
            merged.set(chunk, offset);
            offset += chunk.length;
        }
        this.pendingChunks = [];
        this.pendingSampleCount = 0;
        this.hasSpokenInSegment = false;

        const cb = this.activeCallbacks;
        const modelId = this.activeModelId;

        this.queue = this.queue.then(async () => {
            try {
                await this.ensureModelLoaded(modelId, cb?.onStatus);
                if (!this.transcriber) return;
                cb?.onStatus?.({ state: "transcribing", message: "Processing speech..." });
                const output = await this.transcriber(merged);
                const text = Array.isArray(output)
                    ? output.map((o) => o?.text ?? "").join(" ").trim()
                    : (output?.text ?? "").trim();
                if (text) {
                    cb?.onTranscript(text);
                }
                if (this.recording) {
                    cb?.onStatus?.({ state: "recording", message: "Listening..." });
                }
            } catch (err) {
                cb?.onError?.(err instanceof Error ? err : new Error(String(err)));
            }
        });
    }

    private startWaveformLoop(canvas: HTMLCanvasElement): void {
        const analyser = this.analyser;
        if (!analyser) return;
        const ctx = canvas.getContext("2d");
        if (!ctx) return;

        const bins = new Uint8Array(analyser.frequencyBinCount);

        const draw = () => {
            if (!this.recording || !this.analyser) return;
            this.rafId = requestAnimationFrame(draw);

            const dpr = window.devicePixelRatio || 1;
            const w = canvas.clientWidth || 160;
            const h = canvas.clientHeight || 26;
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

            ctx.fillStyle = getComputedStyle(canvas).color || "#ef4444";

            for (let i = 0; i < barCount; i++) {
                const binIdx = Math.min(bins.length - 1, Math.floor((i / barCount) * (bins.length * 0.7)));
                const norm = (bins[binIdx] ?? 0) / 255;
                const barH = Math.max(3, norm * (h - 4));
                const x = i * (barW + gap);
                const y = (h - barH) / 2;
                ctx.beginPath();
                ctx.roundRect(x, y, barW, barH, 1.5);
                ctx.fill();
            }
        };

        this.rafId = requestAnimationFrame(draw);
    }

    private async ensureModelLoaded(
        modelId: string,
        onStatus?: (update: SttStatusUpdate) => void,
    ): Promise<void> {
        if (this.transcriber && this.loadedModelId === modelId) return;
        if (this.loadingPromise && this.loadedModelId === modelId) {
            await this.loadingPromise;
            return;
        }

        this.loadedModelId = modelId;
        this.transcriber = null;
        this.loadingPromise = (async () => {
            onStatus?.({ state: "loading-model", message: `Loading ${modelId.split("/").pop()}...` });
            // eslint-disable-next-line @typescript-eslint/no-require-imports
            const { env, pipeline } = require("@huggingface/transformers") as typeof import("@huggingface/transformers");

            env.allowLocalModels = false;
            env.useBrowserCache = true;
            if (env.backends?.onnx?.wasm) {
                env.backends.onnx.wasm.numThreads = 1;
                env.backends.onnx.wasm.wasmPaths = "/plugins/siyuan-learnharness/ort/";
            }

            const pipe = await pipeline("automatic-speech-recognition", modelId, {
                device: "wasm",
                dtype: "q8",
                progress_callback: (prog: any) => {
                    if (prog?.status === "progress" && typeof prog.progress === "number") {
                        onStatus?.({
                            state: "loading-model",
                            message: `Downloading voice model (${Math.round(prog.progress)}%)...`,
                        });
                    }
                },
            });
            this.transcriber = pipe as unknown as (
                audio: Float32Array,
            ) => Promise<{ text?: string } | Array<{ text?: string }>>;
        })();

        try {
            await this.loadingPromise;
        } finally {
            this.loadingPromise = null;
        }
    }
}

export const localStt = new LocalSttService();
