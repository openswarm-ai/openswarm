import { useCallback, useEffect, useRef, useState } from 'react';
import { encodeWav, VOICE_SAMPLE_RATE } from './encodeWav';

export type VoiceState = 'idle' | 'recording' | 'transcribing' | 'preparing';

// WhisperFlow-style push-to-dictate: toggle recording (global hotkey or a mic), speak, and the
// transcribed text is pasted into whatever field has focus. Capture is 16kHz mono PCM so it feeds
// whisper.cpp with no server-side resample. The recording path can only be proven with a real mic;
// the encode -> transcribe -> inject half is exercised by the encoder round-trip test.
interface Recorder {
  ctx: AudioContext;
  stream: MediaStream;
  node: ScriptProcessorNode;
  source: MediaStreamAudioSourceNode;
  chunks: Float32Array[];
}

// One object per terminal outcome so the overlay's effect always re-fires (new identity every time).
export interface VoiceFeedback {
  tone: 'ok' | 'warn' | 'error';
  icon: 'check' | 'clipboard' | 'mic' | 'info';
  text: string;
  at: number;
}

export function useVoiceDictation() {
  const [state, setState] = useState<VoiceState>('idle');
  const [lastText, setLastText] = useState<string>('');
  const [error, setError] = useState<string | null>(null);
  const [pct, setPct] = useState<number>(0);
  const [feedback, setFeedback] = useState<VoiceFeedback | null>(null);
  const recRef = useRef<Recorder | null>(null);
  const stateRef = useRef<VoiceState>('idle');
  stateRef.current = state;

  // First-run: the model is downloading. Poll progress until it lands, then drop back to idle so the
  // next click records for real. Never records while preparing, so nothing is lost to a dropped phrase.
  const pollModel = useCallback((): void => {
    const tick = async (): Promise<void> => {
      const st = await window.openswarm?.voiceStatus?.();
      if (!st) { setState('idle'); return; }
      setPct(st.pct || 0);
      if (st.error) { setError(st.error); setState('idle'); return; }
      if (!st.downloading) { setState('idle'); return; }
      setTimeout(() => { void tick(); }, 1000);
    };
    void tick();
  }, []);

  const teardown = useCallback((): Float32Array | null => {
    const rec = recRef.current;
    recRef.current = null;
    if (!rec) return null;
    try { rec.node.disconnect(); } catch (_) { /* already gone */ }
    try { rec.source.disconnect(); } catch (_) { /* already gone */ }
    try { rec.stream.getTracks().forEach((t) => t.stop()); } catch (_) { /* already gone */ }
    try { void rec.ctx.close(); } catch (_) { /* already gone */ }
    const total = rec.chunks.reduce((n, c) => n + c.length, 0);
    if (!total) return new Float32Array(0);
    const out = new Float32Array(total);
    let off = 0;
    for (const c of rec.chunks) { out.set(c, off); off += c.length; }
    return out;
  }, []);

  const start = useCallback(async (): Promise<void> => {
    if (stateRef.current !== 'idle') return;
    if (!window.openswarm?.voiceTranscribe) { setError('desktop-only'); return; } // no Electron bridge = web build
    setError(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true } });
      const ctx = new AudioContext({ sampleRate: VOICE_SAMPLE_RATE });
      const source = ctx.createMediaStreamSource(stream);
      const node = ctx.createScriptProcessor(4096, 1, 1);
      const chunks: Float32Array[] = [];
      node.onaudioprocess = (e): void => { chunks.push(new Float32Array(e.inputBuffer.getChannelData(0))); };
      source.connect(node);
      node.connect(ctx.destination);
      recRef.current = { ctx, stream, node, source, chunks };
      setState('recording');
      // Warm the model the moment recording begins so transcription is instant on stop.
      void window.openswarm?.voiceWarmup?.();
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'mic-unavailable';
      setError(msg);
      const denied = /NotAllowed|Permission|denied/i.test(msg);
      setFeedback({ tone: 'error', icon: 'mic', text: denied ? 'Microphone access needed. Enable it in System Settings, Privacy, Microphone.' : 'Could not start the microphone.', at: Date.now() });
      setState('idle');
    }
  }, []);

  const stop = useCallback(async (): Promise<void> => {
    if (stateRef.current !== 'recording') return;
    const samples = teardown();
    setState('transcribing');
    try {
      if (!samples || samples.length < VOICE_SAMPLE_RATE * 0.2) { setState('idle'); return; } // < 0.2s = a misfire
      const wav = encodeWav(samples);
      const res = await window.openswarm?.voiceTranscribe?.(wav);
      if (res?.ok && res.text) {
        setLastText(res.text);
        const inj = await window.openswarm?.voiceInject?.(res.text);
        setFeedback(inj?.pasted
          ? { tone: 'ok', icon: 'check', text: res.text, at: Date.now() }
          : { tone: 'ok', icon: 'clipboard', text: `${res.text}  (copied, press Cmd+V)`, at: Date.now() });
        setState('idle');
      } else if (res?.ok && !res.text) {
        setFeedback({ tone: 'warn', icon: 'info', text: "Didn't catch that. Try again.", at: Date.now() });
        setState('idle');
      } else if (res?.error === 'model-downloading' || res?.error === 'no-model') {
        // First use kicked off the model fetch; show progress and don't error out.
        setState('preparing');
        pollModel();
      } else {
        setError(res?.error || 'transcription-failed');
        setFeedback({ tone: 'error', icon: 'info', text: 'Voice transcription failed. Try again.', at: Date.now() });
        setState('idle');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'transcription-failed');
      setFeedback({ tone: 'error', icon: 'info', text: 'Voice transcription failed. Try again.', at: Date.now() });
      setState('idle');
    }
  }, [teardown, pollModel]);

  const toggle = useCallback((): void => {
    if (stateRef.current === 'recording') void stop();
    else if (stateRef.current === 'idle') void start();
  }, [start, stop]);

  // Global hotkey (CommandOrControl+Shift+D) routes here from the main process.
  useEffect(() => {
    const off = window.openswarm?.onVoiceToggle?.(() => toggle());
    return () => { off?.(); };
  }, [toggle]);

  // A dangling recorder (unmount mid-capture) must release the mic.
  useEffect(() => () => { teardown(); }, [teardown]);

  return { state, lastText, error, pct, feedback, toggle, start, stop };
}
