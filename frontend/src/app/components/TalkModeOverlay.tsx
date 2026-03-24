import React, { useEffect, useRef, useState, useCallback } from 'react';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import IconButton from '@mui/material/IconButton';
import MicIcon from '@mui/icons-material/Mic';
import MicOffIcon from '@mui/icons-material/MicOff';
import VolumeUpIcon from '@mui/icons-material/VolumeUp';
import CloseIcon from '@mui/icons-material/Close';
import { useClaudeTokens } from '@/shared/styles/ThemeContext';
import { WS_BASE } from '@/shared/config';

type FaceState = 'idle' | 'happy' | 'thinking' | 'talking' | 'surprised' | 'sleeping' | 'angry' | 'love';
type TalkStatus = 'idle' | 'listening' | 'processing' | 'speaking';

interface Props {
  open: boolean;
  onClose: () => void;
  sessionId?: string;
}

// ─── Pixel Face Canvas Renderer ──────────────────────────────────
// Ported from face.html — all the draw logic in one hook.

function usePixelFace(
  canvasRef: React.RefObject<HTMLCanvasElement | null>,
  faceState: FaceState,
  size: number,
) {
  const stateRef = useRef<FaceState>('idle');
  const animRef = useRef<number>(0);

  useEffect(() => {
    stateRef.current = faceState;
  }, [faceState]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const PX = Math.max(4, Math.floor(size / 30));
    const COLS = Math.ceil(size / PX);
    const ROWS = Math.ceil(size / PX);
    canvas.width = COLS * PX;
    canvas.height = ROWS * PX;

    const BG = '#E8927A';
    const EYE = '#1E1E1E';
    const MOUTH = '#1E1E1E';

    let breath = 0, talk = 0, think = 0, sleepZ = 0, heartP = 0;
    let eyeH = 3, eyeHTarget = 3;
    let mouthW = 2, mouthWTarget = 2;
    let mouthH = 2, mouthHTarget = 2;
    let eyeOffX = 0, eyeOffXTarget = 0;
    let eyeOffY = 0, eyeOffYTarget = 0;
    let blinkOpen = true, blinkCD = 120 + Math.random() * 200;
    let doubleBlink = false;
    let idleSinceInput = 0, sleepTransitioned = false;
    let idleAction = 'none', idleActionTimer = 0;
    let idleGlanceX = 0, idleGlanceY = 0;

    const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

    const px = (col: number, row: number, color: string) => {
      ctx.fillStyle = color;
      ctx.fillRect(col * PX, row * PX, PX, PX);
    };

    const pxRect = (x: number, y: number, w: number, h: number, color: string) => {
      for (let r = 0; r < Math.round(h); r++)
        for (let c = 0; c < Math.round(w); c++)
          px(Math.round(x) + c, Math.round(y) + r, color);
    };

    function draw() {
      const state = stateRef.current;

      breath += 0.025;
      talk += 0.3;
      think += 0.025;
      sleepZ += 0.012;
      heartP += 0.05;
      idleSinceInput++;

      if (idleSinceInput > 2700 && state === 'idle' && !sleepTransitioned) {
        stateRef.current = 'sleeping';
        sleepTransitioned = true;
      }

      if (state === 'idle') {
        idleActionTimer--;
        blinkCD--;
        if (blinkCD <= 0 && blinkOpen) { blinkOpen = false; blinkCD = 6; doubleBlink = Math.random() < 0.3; }
        else if (!blinkOpen && blinkCD <= 0) { blinkOpen = true; blinkCD = doubleBlink ? 8 : 100 + Math.random() * 280; doubleBlink = false; }

        if (idleActionTimer <= 0) {
          const roll = Math.random();
          if (roll < 0.3) { idleAction = 'glance'; idleGlanceX = Math.floor(Math.random() * 5) - 2; idleGlanceY = (Math.random() - 0.5) * 1.2; idleActionTimer = 50 + Math.random() * 120; }
          else if (roll < 0.45) { idleAction = 'scan'; idleActionTimer = 180; }
          else if (roll < 0.55) { idleAction = 'squint'; idleActionTimer = 35 + Math.random() * 40; }
          else if (roll < 0.65) { idleAction = 'lookup'; idleActionTimer = 50 + Math.random() * 70; }
          else { idleAction = 'none'; idleGlanceX = 0; idleGlanceY = 0; idleActionTimer = 60 + Math.random() * 200; }
        }
      }

      if (state === 'talking' || state === 'thinking') {
        blinkCD--;
        if (blinkCD <= 0 && blinkOpen) { blinkOpen = false; blinkCD = 6; }
        else if (!blinkOpen && blinkCD <= 0) { blinkOpen = true; blinkCD = 120 + Math.random() * 250; }
      }
      if (state !== 'idle' && state !== 'talking' && state !== 'thinking') blinkOpen = true;

      const b = Math.sin(breath) * 0.3;
      switch (state) {
        case 'idle': {
          eyeHTarget = blinkOpen ? 3 : 0; mouthWTarget = 2; mouthHTarget = 2;
          let gx = 0, gy = b;
          if (idleAction === 'glance') { gx = idleGlanceX; gy = idleGlanceY + b; }
          else if (idleAction === 'scan') { const t = 1 - (idleActionTimer / 180); gx = Math.sin(t * Math.PI * 2) * 2.5; }
          else if (idleAction === 'squint') { eyeHTarget = blinkOpen ? 2 : 0; gy = b + 0.3; }
          else if (idleAction === 'lookup') { gy = -1.2 + b; }
          eyeOffXTarget = gx; eyeOffYTarget = gy; break;
        }
        case 'happy': eyeHTarget = 1; mouthWTarget = 6; mouthHTarget = 1; eyeOffXTarget = 0; eyeOffYTarget = b; break;
        case 'thinking': eyeHTarget = blinkOpen ? 3 : 0; mouthWTarget = 2; mouthHTarget = 2; eyeOffXTarget = 2; eyeOffYTarget = b; break;
        case 'talking': { eyeHTarget = blinkOpen ? 3 : 0; const open = Math.round(Math.abs(Math.sin(talk)) * 2 + 1); mouthWTarget = 4; mouthHTarget = open; eyeOffXTarget = 0; eyeOffYTarget = b; break; }
        case 'surprised': eyeHTarget = 4; mouthWTarget = 3; mouthHTarget = 3; eyeOffXTarget = 0; eyeOffYTarget = b; break;
        case 'sleeping': eyeHTarget = 1; mouthWTarget = 2; mouthHTarget = 1; eyeOffXTarget = 0; eyeOffYTarget = b * 2; break;
        case 'angry': eyeHTarget = 2; mouthWTarget = 6; mouthHTarget = 1; eyeOffXTarget = 0; eyeOffYTarget = b * 0.3; break;
        case 'love': eyeHTarget = 3; mouthWTarget = 2; mouthHTarget = 2; eyeOffXTarget = 0; eyeOffYTarget = b; break;
      }

      eyeH = lerp(eyeH, eyeHTarget, 0.18);
      mouthW = lerp(mouthW, mouthWTarget, 0.15);
      mouthH = lerp(mouthH, mouthHTarget, 0.2);
      eyeOffX = lerp(eyeOffX, eyeOffXTarget, 0.1);
      eyeOffY = lerp(eyeOffY, eyeOffYTarget, 0.15);

      // Draw
      ctx.fillStyle = BG;
      ctx.fillRect(0, 0, canvas.width, canvas.height);

      const cx = Math.floor(COLS / 2);
      const cy = Math.floor(ROWS / 2);
      const eyeSpread = 5, eyeW = 3;
      const eh = Math.max(1, Math.round(eyeH));
      const eOffX = Math.round(eyeOffX), eOffY = Math.round(eyeOffY);
      const eyeBaseY = cy - 2;
      const blinkOff = Math.round((3 - eh) / 2);

      if (state === 'love') {
        const pulse = Math.sin(heartP) > 0 ? '#CC2244' : '#BB1E3E';
        const heart = (hx: number, hy: number) => {
          px(hx - 1, hy, pulse); px(hx + 1, hy, pulse);
          px(hx - 2, hy + 1, pulse); px(hx - 1, hy + 1, pulse); px(hx, hy + 1, pulse); px(hx + 1, hy + 1, pulse); px(hx + 2, hy + 1, pulse);
          px(hx - 1, hy + 2, pulse); px(hx, hy + 2, pulse); px(hx + 1, hy + 2, pulse);
          px(hx, hy + 3, pulse);
        };
        heart(cx - eyeSpread + eOffX, eyeBaseY + eOffY);
        heart(cx + eyeSpread + eOffX, eyeBaseY + eOffY);
      } else {
        pxRect(cx - eyeSpread - 1 + eOffX, eyeBaseY + blinkOff + eOffY, eyeW, eh, EYE);
        pxRect(cx + eyeSpread - 1 + eOffX, eyeBaseY + blinkOff + eOffY, eyeW, eh, EYE);
      }

      if (state === 'angry') {
        const lx = cx - eyeSpread - 1 + eOffX, ly = eyeBaseY + blinkOff + eOffY - 2;
        px(lx, ly + 1, EYE); px(lx + 1, ly, EYE); px(lx + 2, ly, EYE);
        const rx = cx + eyeSpread - 1 + eOffX;
        px(rx + 2, ly + 1, EYE); px(rx + 1, ly, EYE); px(rx, ly, EYE);
      }

      const mw = Math.max(1, Math.round(mouthW)), mh = Math.max(1, Math.round(mouthH));
      const mouthY = cy + 4 + Math.round(eyeOffY);

      if (state === 'happy') {
        pxRect(cx - Math.floor(mw / 2), mouthY, mw, 1, MOUTH);
        px(cx - Math.floor(mw / 2), mouthY - 1, MOUTH);
        px(cx - Math.floor(mw / 2) + mw - 1, mouthY - 1, MOUTH);
      } else if (state === 'angry') {
        pxRect(cx - Math.floor(mw / 2), mouthY, mw, 1, MOUTH);
        px(cx - Math.floor(mw / 2), mouthY + 1, MOUTH);
        px(cx - Math.floor(mw / 2) + mw - 1, mouthY + 1, MOUTH);
      } else {
        pxRect(cx - Math.floor(mw / 2), mouthY, mw, mh, MOUTH);
      }

      if (state === 'sleeping') {
        const zFrame = Math.floor(sleepZ * 60) % 90;
        const zy = Math.round(cy - 5 - (zFrame / 90) * 4);
        const zx = cx + eyeSpread + 3;
        if (zy >= 1 && zFrame < 70) {
          px(zx, zy, '#5577CC'); px(zx + 1, zy, '#5577CC');
          px(zx + 1, zy + 1, '#5577CC');
          px(zx, zy + 2, '#5577CC'); px(zx + 1, zy + 2, '#5577CC');
        }
      }

      if (state === 'thinking') {
        const phase = Math.floor(think * 10) % 4;
        const dx = cx + eyeSpread + 3, dy = cy - 5;
        if (phase >= 1) px(dx, dy, '#7799DD');
        if (phase >= 2) px(dx + 1, dy - 1, '#7799DD');
        if (phase >= 3) px(dx + 2, dy - 2, '#7799DD');
      }

      animRef.current = requestAnimationFrame(draw);
    }

    animRef.current = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(animRef.current);
  }, [canvasRef, size]);
}

// ─── Status Labels ───────────────────────────────────────────────

const STATUS_LABELS: Record<TalkStatus, string> = {
  idle: 'Tap to speak',
  listening: 'Listening...',
  processing: 'Thinking...',
  speaking: 'Speaking...',
};

// ─── Main Component ─────────────────────────────────────────────

const TalkModeOverlay: React.FC<Props> = ({ open, onClose, sessionId }) => {
  const c = useClaudeTokens();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [faceState, setFaceState] = useState<FaceState>('idle');
  const [talkStatus, setTalkStatus] = useState<TalkStatus>('idle');
  const [transcript, setTranscript] = useState('');
  const [agentResponse, setAgentResponse] = useState('');
  const wsRef = useRef<WebSocket | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const silenceTimerRef = useRef<number>(0);
  const audioContextRef = useRef<AudioContext | null>(null);

  usePixelFace(canvasRef, faceState, 240);

  // Map talk status to face state
  useEffect(() => {
    switch (talkStatus) {
      case 'idle': setFaceState('idle'); break;
      case 'listening': setFaceState('idle'); break;
      case 'processing': setFaceState('thinking'); break;
      case 'speaking': setFaceState('talking'); break;
    }
  }, [talkStatus]);

  // WebSocket connection for talk mode
  useEffect(() => {
    if (!open || !sessionId) return;

    const ws = new WebSocket(`${WS_BASE}/ws/talk/${sessionId}`);
    wsRef.current = ws;

    ws.onopen = () => {
      ws.send(JSON.stringify({ type: 'config', stt: {}, tts: {} }));
    };

    ws.onmessage = (event) => {
      const msg = JSON.parse(event.data);

      switch (msg.type) {
        case 'status':
          if (msg.status === 'listening') setTalkStatus('idle');
          else if (msg.status === 'processing') setTalkStatus('processing');
          else if (msg.status === 'speaking') setTalkStatus('speaking');
          break;

        case 'transcript':
          setTranscript(msg.text);
          break;

        case 'agent_response':
          setAgentResponse(msg.text);
          setFaceState('happy');
          setTimeout(() => setFaceState('idle'), 2000);
          break;

        case 'audio': {
          const audioData = atob(msg.data);
          const audioArray = new Uint8Array(audioData.length);
          for (let i = 0; i < audioData.length; i++) audioArray[i] = audioData.charCodeAt(i);

          if (!audioContextRef.current) audioContextRef.current = new AudioContext();
          const audioCtx = audioContextRef.current;
          audioCtx.decodeAudioData(audioArray.buffer.slice(0), (buffer) => {
            const source = audioCtx.createBufferSource();
            source.buffer = buffer;
            source.connect(audioCtx.destination);
            source.onended = () => setTalkStatus('idle');
            source.start(0);
            setTalkStatus('speaking');
          });
          break;
        }
      }
    };

    ws.onerror = () => setFaceState('angry');
    ws.onclose = () => {};

    return () => {
      ws.close();
      wsRef.current = null;
    };
  }, [open, sessionId]);

  // Keyboard: Esc to close
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [open, onClose]);

  const startRecording = useCallback(async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const recorder = new MediaRecorder(stream, { mimeType: 'audio/webm' });
      mediaRecorderRef.current = recorder;

      const chunks: Blob[] = [];
      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunks.push(e.data);
      };

      recorder.onstop = async () => {
        stream.getTracks().forEach((t) => t.stop());
        const blob = new Blob(chunks, { type: 'audio/webm' });
        const reader = new FileReader();
        reader.onload = () => {
          const base64 = (reader.result as string).split(',')[1];
          if (wsRef.current?.readyState === WebSocket.OPEN) {
            wsRef.current.send(JSON.stringify({ type: 'audio', data: base64, format: 'webm' }));
            wsRef.current.send(JSON.stringify({ type: 'end_utterance', format: 'webm' }));
          }
        };
        reader.readAsDataURL(blob);
        setTalkStatus('processing');
      };

      recorder.start();
      setTalkStatus('listening');
      setTranscript('');
      setAgentResponse('');

      // Auto-stop after silence (simple timeout approach)
      silenceTimerRef.current = window.setTimeout(() => {
        if (mediaRecorderRef.current?.state === 'recording') {
          mediaRecorderRef.current.stop();
        }
      }, 5000);
    } catch {
      setFaceState('angry');
    }
  }, []);

  const stopRecording = useCallback(() => {
    window.clearTimeout(silenceTimerRef.current);
    if (mediaRecorderRef.current?.state === 'recording') {
      mediaRecorderRef.current.stop();
    }
  }, []);

  const handleMicClick = useCallback(() => {
    if (talkStatus === 'listening') {
      stopRecording();
    } else if (talkStatus === 'idle') {
      startRecording();
    }
  }, [talkStatus, startRecording, stopRecording]);

  if (!open) return null;

  const micBg =
    talkStatus === 'listening' ? c.accent.primary :
    talkStatus === 'speaking' ? '#4caf50' :
    c.bg.elevated;

  return (
    <Box
      sx={{
        position: 'fixed',
        inset: 0,
        zIndex: 9999,
        bgcolor: 'rgba(0, 0, 0, 0.75)',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        backdropFilter: 'blur(8px)',
        animation: 'fadeIn 300ms cubic-bezier(0.165, 0.85, 0.45, 1)',
        '@keyframes fadeIn': { from: { opacity: 0 }, to: { opacity: 1 } },
        '@keyframes pulse': {
          '0%': { boxShadow: `0 0 0 0 ${c.accent.primary}60` },
          '70%': { boxShadow: `0 0 0 16px ${c.accent.primary}00` },
          '100%': { boxShadow: `0 0 0 0 ${c.accent.primary}00` },
        },
      }}
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      {/* Close button */}
      <IconButton
        onClick={onClose}
        sx={{
          position: 'absolute',
          top: 24,
          right: 24,
          color: 'rgba(255,255,255,0.5)',
          '&:hover': { color: 'rgba(255,255,255,0.9)' },
        }}
      >
        <CloseIcon />
      </IconButton>

      {/* Face canvas */}
      <Box
        sx={{
          borderRadius: 4,
          overflow: 'hidden',
          boxShadow: '0 8px 40px rgba(0,0,0,0.4)',
          mb: 3,
        }}
      >
        <canvas
          ref={canvasRef}
          style={{
            display: 'block',
            imageRendering: 'pixelated',
            width: 240,
            height: 240,
            borderRadius: 16,
          }}
        />
      </Box>

      {/* Status label */}
      <Typography
        sx={{
          color: 'rgba(255,255,255,0.5)',
          fontSize: '0.85rem',
          fontWeight: 500,
          mb: 3,
          fontFamily: c.font.sans,
          letterSpacing: 0.3,
        }}
      >
        {STATUS_LABELS[talkStatus]}
      </Typography>

      {/* Transcript area */}
      <Box sx={{ maxWidth: 440, width: '100%', px: 3, mb: 2, minHeight: 80 }}>
        {transcript && (
          <Typography
            sx={{
              color: 'rgba(255,255,255,0.4)',
              fontSize: '0.9rem',
              fontStyle: 'italic',
              textAlign: 'center',
              mb: 1.5,
              fontFamily: c.font.sans,
              animation: 'fadeIn 200ms ease',
            }}
          >
            "{transcript}"
          </Typography>
        )}

        {agentResponse && (
          <Typography
            sx={{
              color: 'rgba(255,255,255,0.85)',
              fontSize: '0.95rem',
              textAlign: 'center',
              fontFamily: c.font.sans,
              lineHeight: 1.5,
              animation: 'fadeIn 300ms ease',
            }}
          >
            {agentResponse}
          </Typography>
        )}
      </Box>

      {/* Mic button */}
      <IconButton
        onClick={handleMicClick}
        sx={{
          width: 56,
          height: 56,
          bgcolor: micBg,
          color: talkStatus === 'listening' ? '#fff' : c.text.primary,
          '&:hover': { bgcolor: micBg, opacity: 0.9 },
          transition: 'all 200ms ease',
          animation: talkStatus === 'listening' ? 'pulse 1.5s infinite' : 'none',
          mt: 2,
        }}
      >
        {talkStatus === 'listening' ? <MicIcon sx={{ fontSize: 28 }} /> :
         talkStatus === 'speaking' ? <VolumeUpIcon sx={{ fontSize: 28 }} /> :
         <MicIcon sx={{ fontSize: 28 }} />}
      </IconButton>

      {/* Hint */}
      <Typography
        sx={{
          color: 'rgba(255,255,255,0.2)',
          fontSize: '0.7rem',
          mt: 3,
          fontFamily: c.font.sans,
        }}
      >
        esc to close
      </Typography>
    </Box>
  );
};

export default TalkModeOverlay;
