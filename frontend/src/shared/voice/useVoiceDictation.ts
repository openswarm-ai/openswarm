import { useCallback, useEffect, useRef, useState } from 'react';
import { API_BASE } from '@/shared/config';
import { getLastInteractedBrowser } from '@/shared/browserFocus';
import { encodeWav, VOICE_SAMPLE_RATE } from './encodeWav';
import { playVoiceCue } from './voiceCues';
import { injectAtFocus, snapshotInjectTarget } from './injectAtFocus';
import { clearInjectSnapshot } from './injectTargetSnapshot';
import { createSilenceDetector } from './createSilenceDetector';
import { pushDictation } from './voiceHistory';
import { learnFromTranscript, isDictionaryEcho } from './voiceDictionary';
import { getFocusedSurfaceHost, surfaceDisabled } from './voiceSurface';
import { store } from '@/shared/state/store';
import { createCaptureNode } from './createCaptureNode';

export type VoiceState = 'idle' | 'recording' | 'transcribing' | 'preparing';

// Live transcript preview: committed phrases are decoded once and never rewritten; the tentative
// tail is the latest hypothesis for the phrase still being spoken.
export interface VoicePartial {
  committed: string;
  tentative: string;
}

// WhisperFlow-style push-to-dictate: toggle recording (global hotkey or a mic), speak, and the
// transcribed text is pasted into whatever field has focus. Capture is 16kHz mono PCM off the audio
// thread (AudioWorklet) so it feeds whisper.cpp with no server-side resample, and the same chunks
// stream to main for live partials. The recording path can only be proven with a real mic;
// the encode -> transcribe -> inject half is exercised by the encoder round-trip test.
interface Recorder {
  ctx: AudioContext;
  stream: MediaStream;
  node: AudioNode;
  requestFlush: () => Promise<void>;
  source: MediaStreamAudioSourceNode;
  chunks: Float32Array[];
  streaming: boolean;
}

interface WarmMic {
  stream: MediaStream;
  ctx: AudioContext;
  timer: number;
}

const WARM_MIC_GRACE_MS = 5 * 60_000;

// One object per terminal outcome so the overlay's effect always re-fires (new identity every time).
export interface VoiceFeedback {
  tone: 'ok' | 'warn' | 'error';
  icon: 'check' | 'clipboard' | 'mic' | 'info';
  text: string;
  at: number;
}

// Where the transcript will land RIGHT NOW, in the user's words plus the surface's own icon;
// mirrors injectAtFocus's tiers so the chip never promises a destination injection would not pick.
export interface InjectTargetInfo {
  label: string;
  icon: string | null;
  // Which composer owns the dictation right now (its data-osw-composer id), or null when the
  // target is not a composer. Lets each composer show "Stop dictation" only when IT is the target
  // instead of every chat lighting up at once (ENG-239).
  composerId: string | null;
}

function browserTargetInfo(): InjectTargetInfo {
  const browserId = getLastInteractedBrowser();
  const card = browserId ? store.getState().dashboardLayout.browserCards[browserId] : undefined;
  const tab = card?.tabs?.find((t) => t.id === card.activeTabId);
  const host = (() => { try { return tab?.url ? new URL(tab.url).hostname : null; } catch { return null; } })();
  return { label: host || 'browser page', icon: tab?.favicon || null, composerId: null };
}

export function describeInjectTarget(): InjectTargetInfo {
  const a = document.activeElement as HTMLElement | null;
  const composerId = a?.closest?.('[data-osw-composer]')?.getAttribute('data-osw-composer') ?? null;
  if (a && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA' || a.isContentEditable)) {
    const hint = a.getAttribute('placeholder') || a.getAttribute('aria-label');
    return { label: hint ? hint.slice(0, 30) : 'text field', icon: null, composerId };
  }
  if (a && a.tagName === 'WEBVIEW') return browserTargetInfo();
  if (getLastInteractedBrowser()) return browserTargetInfo();
  return { label: 'chat composer', icon: null, composerId };
}

// Context hint for the polisher: what the user is dictating into (a field label, a page title), so
// names and jargon spell right. Never page CONTENT, just the one-line "where".
function dictationContext(): string {
  const active = document.activeElement as HTMLElement | null;
  const hint = active?.getAttribute?.('placeholder') || active?.getAttribute?.('aria-label') || '';
  return [hint, document.title].filter(Boolean).join(' - ').slice(0, 200);
}

async function polishText(raw: string): Promise<string> {
  try {
    const ctl = new AbortController();
    const timer = window.setTimeout(() => ctl.abort(), 6500);
    const res = await fetch(`${API_BASE}/voice/polish`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: raw, context: dictationContext() }),
      signal: ctl.signal,
    });
    window.clearTimeout(timer);
    if (!res.ok) return raw;
    const data = (await res.json()) as { text?: string };
    return data.text?.trim() || raw;
  } catch {
    return raw;
  }
}

export function useVoiceDictation() {
  const [state, setState] = useState<VoiceState>('idle');
  const [lastText, setLastText] = useState<string>('');
  const [error, setError] = useState<string | null>(null);
  const [pct, setPct] = useState<number>(0);
  const [feedback, setFeedback] = useState<VoiceFeedback | null>(null);
  const [partial, setPartial] = useState<VoicePartial | null>(null);
  const [target, setTarget] = useState<InjectTargetInfo>({ label: '', icon: null, composerId: null });
  const partialSeqRef = useRef<number>(0);
  const recRef = useRef<Recorder | null>(null);
  const warmMicRef = useRef<WarmMic | null>(null);
  const stateRef = useRef<VoiceState>('idle');
  // Live mic level (0..1) for the aurora; a ref, not state, so 60Hz visuals never re-render React.
  const volumeRef = useRef<number>(0);
  // The capture callback has to reach stop(), which is defined after start(); a ref breaks the knot.
  const stopRef = useRef<(() => Promise<void>) | null>(null);
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

  // ENG-210: macOS powers the input device down when the last stream closes and the next open costs
  // ~2.5s (worse on Bluetooth, which renegotiates HFP per open). Park the live stream + context for a
  // grace window instead of stopping them; the next fn press reconnects in ~5ms. Tracks are disabled
  // while parked so nothing is captured; the OS mic indicator stays lit for the window, Eric's call.
  const releaseWarmMic = useCallback((): void => {
    const warm = warmMicRef.current;
    warmMicRef.current = null;
    if (!warm) return;
    window.clearTimeout(warm.timer);
    try { warm.stream.getTracks().forEach((t) => t.stop()); } catch (_) { /* already dead */ }
    try { void warm.ctx.close(); } catch (_) { /* already closed */ }
  }, []);

  const parkWarmMic = useCallback((stream: MediaStream, ctx: AudioContext): void => {
    releaseWarmMic();
    if (!stream.getTracks().some((t) => t.readyState === 'live') || ctx.state === 'closed') {
      try { stream.getTracks().forEach((t) => t.stop()); } catch (_) { /* already dead */ }
      try { void ctx.close(); } catch (_) { /* already closed */ }
      return;
    }
    stream.getTracks().forEach((t) => { t.enabled = false; });
    const timer = window.setTimeout(() => releaseWarmMic(), WARM_MIC_GRACE_MS);
    warmMicRef.current = { stream, ctx, timer };
  }, [releaseWarmMic]);

  useEffect(() => () => releaseWarmMic(), [releaseWarmMic]);

  const teardown = useCallback((): Float32Array | null => {
    const rec = recRef.current;
    recRef.current = null;
    if (!rec) return null;
    try { rec.node.disconnect(); } catch (_) { /* already gone */ }
    try { rec.source.disconnect(); } catch (_) { /* already gone */ }
    parkWarmMic(rec.stream, rec.ctx);
    const total = rec.chunks.reduce((n, c) => n + c.length, 0);
    if (!total) return new Float32Array(0);
    const out = new Float32Array(total);
    let off = 0;
    for (const c of rec.chunks) { out.set(c, off); off += c.length; }
    return out;
  }, [parkWarmMic]);

  // `hold` = the user is physically holding a key or button, so they own the end of the utterance
  // and silence must never cut them off mid-thought. Only a tap session endpoints itself.
  const start = useCallback(async (hold = false): Promise<void> => {
    if (stateRef.current !== 'idle') return;
    if (!window.openswarm?.voiceTranscribe) { setError('desktop-only'); return; } // no Electron bridge = web build
    // Per-surface disable: the user marked this site as no-dictation; refuse loudly, never silently.
    const disabledList = store.getState().settings.data.dictation_disabled_surfaces ?? '';
    if (disabledList) {
      const host = getFocusedSurfaceHost();
      if (surfaceDisabled(disabledList, host)) {
        setFeedback({ tone: 'warn', icon: 'mic', text: `Dictation is off for ${host}. Change it in Settings > Interface.`, at: Date.now() });
        return;
      }
    }
    setError(null);
    // Where the words belong is decided NOW, while the user is looking at it, not seconds later.
    snapshotInjectTarget();
    // Warm on the DOWN edge, before the mic prompt, so the model load overlaps the user starting to speak.
    void window.openswarm?.voiceWarmup?.();
    setPartial(null);
    partialSeqRef.current = 0;
    let stream: MediaStream | null = null;
    let ctx: AudioContext | null = null;
    try {
      // Everything below used to run SERIAL and speech during that window is simply dropped, so it
      // was all felt latency (measured live on the packaged build: mic 210ms warm / 2.5s cold on a
      // powered-down input device, plus ~115ms of IPC + context + worklet). Only getUserMedia is
      // physics; the rest overlaps it now. The TCC prompt (ENG-103) still fires via
      // voiceRequestMicAccess; in parallel is safe because pre-grant getUserMedia fails right too.
      const micOkP: Promise<boolean> = (window.openswarm as any)?.voiceRequestMicAccess?.() ?? Promise.resolve(true);
      // A parked warm mic (ENG-210) skips getUserMedia entirely; a dead one is released and we fall
      // through to a fresh open. Popped from the ref FIRST so a failure below can never double-use it.
      const warm = warmMicRef.current;
      warmMicRef.current = null;
      if (warm) window.clearTimeout(warm.timer);
      const warmLive = !!warm && warm.stream.getTracks().some((t) => t.readyState === 'live') && warm.ctx.state !== 'closed';
      if (warm && !warmLive) {
        try { warm.stream.getTracks().forEach((t) => t.stop()); } catch (_) { /* already dead */ }
        try { void warm.ctx.close(); } catch (_) { /* already closed */ }
      }
      if (warmLive) warm.stream.getTracks().forEach((t) => { t.enabled = true; });
      // autoGainControl OFF is the OSS-dictation consensus (Chromium's hidden AGC rides the mic and
      // garbles levels mid-utterance; none of the five surveyed shipping apps allow any AGC), and
      // noiseSuppression smears speech whisper handles better raw. Echo cancellation stays: we play
      // cues out the speakers while the mic is hot.
      const streamP = warmLive
        ? Promise.resolve(warm.stream)
        : navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: false, autoGainControl: false } });
      ctx = warmLive ? warm.ctx : new AudioContext({ sampleRate: VOICE_SAMPLE_RATE });
      if (ctx.state === 'suspended') void ctx.resume();
      const chunks: Float32Array[] = [];
      const endpointer = hold ? null : createSilenceDetector(ctx.sampleRate);
      // Read through a let: the capture node is built while stream-start is still in flight, and no
      // chunk can flow before the source connects below, by which point this is assigned.
      let streaming = false;
      // No AGC: boosting "quiet" speech clipped NORMAL speech into distortion and wrecked accuracy
      // (Eric's garbled-history report). Whisper handles real levels fine; a whisper-mode boost can
      // only come back as an opt-in with a proper peak limiter, never inline on the hot path.
      const captureP = createCaptureNode(ctx, (i16) => {
        if (streaming) window.openswarm?.voiceStreamChunk?.(i16.buffer as ArrayBuffer);
        const data = new Float32Array(i16.length);
        for (let i = 0; i < i16.length; i++) data[i] = i16[i] / 0x8000;
        chunks.push(data);
        // RMS per chunk drives the waveform; fast attack + slower release, like a real peak meter,
        // so the bars snap to speech instead of lagging behind it.
        let sum = 0;
        for (let i = 0; i < data.length; i += 8) sum += data[i] * data[i];
        const rms = Math.sqrt(sum / (data.length / 8));
        const level = Math.min(1, rms * 7);
        volumeRef.current = level > volumeRef.current
          ? volumeRef.current * 0.35 + level * 0.65
          : volumeRef.current * 0.78 + level * 0.22;
        if (endpointer && endpointer.push(data) !== 'listening') void stopRef.current?.();
      });
      const [micOk, streamGot, streamRes, capture] = await Promise.all([
        micOkP, streamP, window.openswarm?.voiceStreamStart?.() ?? Promise.resolve(undefined), captureP,
      ]);
      stream = streamGot;
      if (micOk === false) {
        stream.getTracks().forEach((t) => t.stop());
        setError('mic-denied');
        return;
      }
      streaming = streamRes?.ok === true;
      const source = ctx.createMediaStreamSource(stream);
      source.connect(capture.node);
      capture.node.connect(ctx.destination);
      recRef.current = { ctx, stream, node: capture.node, requestFlush: capture.requestFlush, source, chunks, streaming };
      setState('recording');
      playVoiceCue('start');
      if (store.getState().settings.data.dictation_haptics ?? true) void (window.openswarm as { haptic?: (p: string) => Promise<boolean> } | undefined)?.haptic?.('generic');
    } catch (err) {
      // Release whatever was acquired before the failure, or the OS mic indicator stays lit forever on a half-started session.
      try { stream?.getTracks().forEach((t) => t.stop()); } catch { /* already dead */ }
      try { void ctx?.close(); } catch { /* already closed */ }
      const msg = err instanceof Error ? err.message : 'mic-unavailable';
      setError(msg);
      const denied = /NotAllowed|Permission|denied/i.test(msg);
      setFeedback({ tone: 'error', icon: 'mic', text: denied ? 'Microphone access needed. Enable it in System Settings, Privacy, Microphone.' : 'Could not start the microphone.', at: Date.now() });
      setState('idle');
    }
  }, []);

  const stop = useCallback(async (): Promise<void> => {
    if (stateRef.current !== 'recording') return;
    const rec = recRef.current;
    const streaming = rec?.streaming === true;
    // Drain the capture's last partial buffer before teardown (worklet flush carries its own 1s watchdog).
    if (rec) await rec.requestFlush();
    const samples = teardown();
    playVoiceCue('stop');
    if (store.getState().settings.data.dictation_haptics ?? true) void (window.openswarm as { haptic?: (p: string) => Promise<boolean> } | undefined)?.haptic?.('alignment');
    setState('transcribing');
    try {
      if (!samples || samples.length < VOICE_SAMPLE_RATE * 0.2) { // < 0.2s = a misfire
        if (streaming) window.openswarm?.voiceStreamCancel?.();
        setPartial(null);
        setState('idle');
        return;
      }
      // Accuracy first (Eric's call): phrases decoded in isolation lose whisper's cross-phrase
      // context, which read as "sometimes fine, sometimes off". The FULL clip is always decoded at
      // stop and wins; the streamed assembly only stands in if the batch decode fails outright.
      // Fire the streaming shutdown but DON'T wait for it here: it blocks on the session's in-flight
      // partial decode, and its text is only ever needed if the batch decode below fails outright.
      // Awaiting it up front sat between the user's stop and the answer on every single dictation.
      const streamStopP = streaming ? window.openswarm?.voiceStreamStop?.() : null;
      let res: { ok: boolean; text?: string; error?: string } | undefined;
      {
        // OpenWhispr's window gate: whole-clip RMS misses a clip that is silence plus one cough, so
        // judge 100ms windows; no window with real speech energy means no decode, ever.
        const win = Math.round(VOICE_SAMPLE_RATE * 0.1);
        let peakRms = 0;
        let speechWindow = false;
        for (let off = 0; off + win <= samples.length; off += win) {
          let sumSq = 0;
          let peak = 0;
          for (let i = off; i < off + win; i += 2) { const v = samples[i]; sumSq += v * v; if (Math.abs(v) > peak) peak = Math.abs(v); }
          const wr = Math.sqrt(sumSq / (win / 2));
          if (wr > peakRms) peakRms = wr;
          if (wr >= 0.003 && peak >= 0.02) speechWindow = true;
        }
        if (peakRms < 0.002 || (!speechWindow && peakRms < 0.006)) {
          res = { ok: true, text: '' };
        } else {
          // whisper.cpp asserts on sub-second buffers; zero-pad instead of rejecting (FluidVoice).
          const padded = samples.length < VOICE_SAMPLE_RATE
            ? (() => { const b = new Float32Array(VOICE_SAMPLE_RATE); b.set(samples); return b; })()
            : samples;
          const wav = encodeWav(padded);
          res = await window.openswarm?.voiceTranscribe?.(wav);
          if ((!res || !res.ok || !res.text) && streamStopP) {
            const sres = await streamStopP;
            if (sres?.ok && sres.text) res = { ok: true, text: sres.text };
          }
        }
      }
      // Whisper captions non-speech in brackets/parens ("[ Background sounds ]", "(laughs)") and marks speaker turns with ">>"; those are annotations, not dictation.
      if (res?.ok && res.text) res = { ok: true, text: res.text.replace(/\[[^\]]*\]|\([^)]*\)|\*[^*]*\*|(?:^|\s)>>\s?/g, ' ').replace(/\s+/g, ' ').trim() };
      // Stutter collapse (Handy): three or more consecutive identical words are one decode loop, not speech.
      if (res?.ok && res.text) res = { ok: true, text: res.text.replace(/\b([A-Za-z']+)(\s+\1\b){2,}/gi, '$1') };
      // Glossary echo (OpenWhispr): a transcript that is mostly the dictionary read back is the prompt leaking, not dictation.
      if (res?.ok && res.text && isDictionaryEcho(res.text)) res = { ok: true, text: '' };
      // A transcript with no letter or digit in it is a hallucination artifact (the lone comma), not dictation.
      if (res?.ok && res.text && !/[\p{L}\p{N}]/u.test(res.text)) res = { ok: true, text: '' };
      // Wispr's command grammar, v1: saying only "scratch that" (or "delete/cancel that") throws the take away.
      if (res?.ok && res.text && /^(scratch|delete|cancel) that[.!?]?$/i.test(res.text.trim())) {
        setFeedback({ tone: 'ok', icon: 'check', text: 'Scratched.', at: Date.now() });
        setState('idle');
        return;
      }
      if (res?.ok && res.text) {
        // WhisperFlow-style cleanup: punctuation + filler words via the cheap aux tier, fail-open to
        // the raw transcript on any error/timeout so dictation never breaks with the aux down.
        // Latency: short phrases don't need the aux cleanup (whisper's raw output is fine), and a
        // slow aux must never hold the cursor hostage; 900ms is the most polish is allowed to cost.
        const raw = res.text.trim();
        const text = raw.split(/\s+/).length <= 6
          ? raw
          : await Promise.race([polishText(raw), new Promise<string>((r) => window.setTimeout(() => r(raw), 900))]);
        setLastText(text);
        // Land the text where the user's cursor is: focused field, then focused browser page, then
        // the OS paste fallback (other apps). The floating bubble is just confirmation, not the output.
        // Success is silent: the text landing at the cursor IS the feedback. Only the clipboard
        // fallback still speaks, because the user has to act (paste) to get the text.
        const target = injectAtFocus(text);
        pushDictation(text, target || 'clipboard');
        learnFromTranscript(text);
        if (!target) {
          const inj = await window.openswarm?.voiceInject?.(text);
          if (!inj?.pasted) setFeedback({ tone: 'ok', icon: 'clipboard', text: `${text}  (copied, press Cmd+V)`, at: Date.now() });
        }
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

  stopRef.current = stop;

  // The capsule's X: throw the take away. No transcription, no cue, straight back to idle.
  const cancel = useCallback((): void => {
    if (stateRef.current !== 'recording') return;
    clearInjectSnapshot();
    const rec = recRef.current;
    if (rec?.streaming) window.openswarm?.voiceStreamCancel?.();
    teardown();
    setPartial(null);
    setState('idle');
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

  // Live partials from the main-process streaming session; the seq guard drops anything a stale
  // session (previous recording's in-flight decode) manages to emit after a new one started.
  useEffect(() => {
    const off = window.openswarm?.onVoicePartial?.((p) => {
      if (p.seq <= partialSeqRef.current) return;
      partialSeqRef.current = p.seq;
      if (stateRef.current === 'recording' || stateRef.current === 'transcribing') {
        setPartial({ committed: p.committed, tentative: p.tentative });
      }
    });
    return () => { off?.(); };
  }, []);

  // The preview belongs to a live session only; any terminal state clears it in one place.
  useEffect(() => {
    if (state === 'idle' || state === 'preparing') setPartial(null);
  }, [state]);

  // The target chip tracks focus LIVE while recording: clicking into a field mid-dictation retargets
  // injection (by design), and the chip must tell that truth as it happens.
  useEffect(() => {
    if (state !== 'recording') { setTarget({ label: '', icon: null, composerId: null }); return undefined; }
    setTarget(describeInjectTarget());
    const onFocus = (): void => setTarget(describeInjectTarget());
    window.addEventListener('focusin', onFocus, true);
    window.addEventListener('focusout', onFocus, true);
    return () => {
      window.removeEventListener('focusin', onFocus, true);
      window.removeEventListener('focusout', onFocus, true);
    };
  }, [state]);

  // A dangling recorder (unmount mid-capture) must release the mic.
  useEffect(() => () => { teardown(); }, [teardown]);

  // One-line notices from outside the session flow (Globe-key conflict, permission hints) ride the same bubble.
  const notify = useCallback((text: string): void => {
    setFeedback({ tone: 'warn', icon: 'info', text, at: Date.now() });
  }, []);

  return { state, lastText, error, pct, feedback, partial, target, toggle, start, stop, cancel, notify, volumeRef };
}
