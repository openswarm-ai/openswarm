import { useCallback, useEffect, useRef, useState } from 'react';
import { encodeWav, VOICE_SAMPLE_RATE } from '@/shared/voice/encodeWav';

export type VoiceState = 'idle' | 'recording' | 'transcribing';

// WhisperFlow-style push-to-dictate: toggle recording (global hotkey or the pill), speak, and the
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

export function useVoiceDictation() {
  const [state, setState] = useState<VoiceState>('idle');
  const [lastText, setLastText] = useState<string>('');
  const [error, setError] = useState<string | null>(null);
  const recRef = useRef<Recorder | null>(null);
  const stateRef = useRef<VoiceState>('idle');
  stateRef.current = state;

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
      setError(err instanceof Error ? err.message : 'mic-unavailable');
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
        await window.openswarm?.voiceInject?.(res.text);
      } else {
        setError(res?.error || 'transcription-failed');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'transcription-failed');
    } finally {
      setState('idle');
    }
  }, [teardown]);

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

  return { state, lastText, error, toggle, start, stop };
}
