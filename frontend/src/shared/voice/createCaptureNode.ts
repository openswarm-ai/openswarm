// One capture interface, two implementations: the AudioWorklet (off-thread, 50ms Int16 chunks with
// a drain handshake) with the deprecated ScriptProcessor as the always-works fallback. Capture
// plumbing failing must degrade dictation, never kill it: the first worklet rollout died on CSP
// (blob: module URLs are script-src, not worker-src) and the generic catch read "mic broken".

export interface CaptureNode {
  node: AudioNode;
  // Drains any buffered tail; resolves when the last samples have been delivered.
  requestFlush: () => Promise<void>;
}

export async function createCaptureNode(ctx: AudioContext, onPcm: (pcm: Int16Array) => void): Promise<CaptureNode> {
  try {
    await ctx.audioWorklet.addModule(new URL('pcm-worklet.js', window.location.href).toString());
    const node = new AudioWorkletNode(ctx, 'pcm-streaming-processor');
    let flushResolve: () => void = () => {};
    const flushed = new Promise<void>((resolve) => { flushResolve = resolve; });
    node.port.onmessage = (e: MessageEvent): void => {
      if (e.data === 'flushed') { flushResolve(); return; }
      onPcm(new Int16Array(e.data as ArrayBuffer));
    };
    return {
      node,
      requestFlush: () => {
        try { node.port.postMessage('stop'); } catch (_) { /* node already gone */ }
        return Promise.race([flushed, new Promise<void>((resolve) => window.setTimeout(resolve, 1000))]);
      },
    };
  } catch (err) {
    console.warn('[voice] worklet capture unavailable, using ScriptProcessor:', err instanceof Error ? err.message : err);
    const node = ctx.createScriptProcessor(4096, 1, 1);
    node.onaudioprocess = (e): void => {
      const data = e.inputBuffer.getChannelData(0);
      const i16 = new Int16Array(data.length);
      for (let i = 0; i < data.length; i++) {
        const s = Math.max(-1, Math.min(1, data[i]));
        i16[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
      }
      onPcm(i16);
    };
    // ScriptProcessor delivers synchronously per 4096-frame block; there is no tail to drain.
    return { node, requestFlush: () => Promise.resolve() };
  }
}
