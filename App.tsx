
import React, { useState, useRef, useCallback, useEffect } from 'react';
import { GoogleGenAI, Modality, LiveServerMessage } from '@google/genai';
import { SessionState, TranscriptionItem } from './types';
import { createBlob, decode, decodeAudioData, encode } from './utils/audioUtils';

const FRAME_RATE = 1; // Frames per second for vision input
const JPEG_QUALITY = 0.6;
const INPUT_SAMPLE_RATE = 16000;
const OUTPUT_SAMPLE_RATE = 24000;

const App: React.FC = () => {
  const [session, setSession] = useState<SessionState>({
    isActive: false,
    isMuted: false,
    isScreenSharing: false,
    status: 'idle',
    error: null,
  });

  const [transcriptions, setTranscriptions] = useState<TranscriptionItem[]>([]);
  
  // Audio Refs
  const inputAudioCtxRef = useRef<AudioContext | null>(null);
  const outputAudioCtxRef = useRef<AudioContext | null>(null);
  const nextStartTimeRef = useRef<number>(0);
  const audioSourcesRef = useRef<Set<AudioBufferSourceNode>>(new Set());
  
  // Stream Refs
  const screenStreamRef = useRef<MediaStream | null>(null);
  const micStreamRef = useRef<MediaStream | null>(null);
  
  // Live Session Ref
  const sessionPromiseRef = useRef<Promise<any> | null>(null);
  
  // Visual Refs
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const frameIntervalRef = useRef<number | null>(null);

  const stopAllStreams = useCallback(() => {
    if (screenStreamRef.current) {
      screenStreamRef.current.getTracks().forEach(t => t.stop());
      screenStreamRef.current = null;
    }
    if (micStreamRef.current) {
      micStreamRef.current.getTracks().forEach(t => t.stop());
      micStreamRef.current = null;
    }
    if (frameIntervalRef.current) {
      window.clearInterval(frameIntervalRef.current);
      frameIntervalRef.current = null;
    }
    audioSourcesRef.current.forEach(s => s.stop());
    audioSourcesRef.current.clear();
  }, []);

  const handleStopSession = useCallback(() => {
    stopAllStreams();
    setSession(prev => ({ ...prev, isActive: false, isScreenSharing: false, status: 'idle' }));
  }, [stopAllStreams]);

  const startLiveSession = async () => {
    try {
      setSession(prev => ({ ...prev, status: 'connecting', error: null }));
      
      const ai = new GoogleGenAI({ apiKey: process.env.API_KEY || '' });
      
      // Initialize Audio Contexts
      if (!inputAudioCtxRef.current) {
        inputAudioCtxRef.current = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: INPUT_SAMPLE_RATE });
      }
      if (!outputAudioCtxRef.current) {
        outputAudioCtxRef.current = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: OUTPUT_SAMPLE_RATE });
      }

      // 1. Get Microphone
      const micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      micStreamRef.current = micStream;

      // 2. Get Screen
      let screenStream: MediaStream;
      try {
        screenStream = await navigator.mediaDevices.getDisplayMedia({ 
          video: { cursor: "always" } as any,
          audio: false 
        });
      } catch (displayErr: any) {
        if (displayErr.name === 'NotAllowedError' || displayErr.message.includes('permissions policy')) {
          throw new Error("Screen sharing is blocked by your browser's permissions policy. Try opening this app in a full window (pop-out) or check your browser settings to allow display capture.");
        }
        throw displayErr;
      }
      
      screenStreamRef.current = screenStream;
      if (videoRef.current) {
        videoRef.current.srcObject = screenStream;
      }

      // Handle screen stream end (e.g. user clicks "Stop Sharing" browser button)
      screenStream.getVideoTracks()[0].onended = () => {
        handleStopSession();
      };

      let currentInputTranscription = '';
      let currentOutputTranscription = '';

      // Connect to Gemini Live
      const sessionPromise = ai.live.connect({
        model: 'gemini-2.5-flash-native-audio-preview-09-2025',
        config: {
          responseModalities: [Modality.AUDIO],
          speechConfig: {
            voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Zephyr' } },
          },
          systemInstruction: 'You are an AI assistant that can see the users screen and hear their voice. Help them with what they are doing in real-time. Keep responses concise and natural.',
          inputAudioTranscription: {},
          outputAudioTranscription: {},
        },
        callbacks: {
          onopen: () => {
            console.log('Session opened');
            setSession(prev => ({ ...prev, status: 'connected', isActive: true, isScreenSharing: true }));

            // Start Audio Processing
            const source = inputAudioCtxRef.current!.createMediaStreamSource(micStream);
            const scriptProcessor = inputAudioCtxRef.current!.createScriptProcessor(4096, 1, 1);
            
            scriptProcessor.onaudioprocess = (e) => {
              const inputData = e.inputBuffer.getChannelData(0);
              const pcmBlob = createBlob(inputData);
              sessionPromiseRef.current?.then((s) => {
                s.sendRealtimeInput({ media: pcmBlob });
              });
            };
            
            source.connect(scriptProcessor);
            scriptProcessor.connect(inputAudioCtxRef.current!.destination);

            // Start Video Frame Streaming
            frameIntervalRef.current = window.setInterval(() => {
              if (videoRef.current && canvasRef.current && sessionPromiseRef.current) {
                const ctx = canvasRef.current.getContext('2d');
                if (!ctx) return;
                
                canvasRef.current.width = videoRef.current.videoWidth || 640;
                canvasRef.current.height = videoRef.current.videoHeight || 360;
                ctx.drawImage(videoRef.current, 0, 0, canvasRef.current.width, canvasRef.current.height);
                
                canvasRef.current.toBlob(async (blob) => {
                  if (blob) {
                    const reader = new FileReader();
                    reader.onloadend = () => {
                      const base64Data = (reader.result as string).split(',')[1];
                      sessionPromiseRef.current?.then((s) => {
                        s.sendRealtimeInput({
                          media: { data: base64Data, mimeType: 'image/jpeg' }
                        });
                      });
                    };
                    reader.readAsDataURL(blob);
                  }
                }, 'image/jpeg', JPEG_QUALITY);
              }
            }, 1000 / FRAME_RATE);
          },
          onmessage: async (message: LiveServerMessage) => {
            // Handle Audio Data
            const base64Audio = message.serverContent?.modelTurn?.parts[0]?.inlineData?.data;
            if (base64Audio && outputAudioCtxRef.current) {
              nextStartTimeRef.current = Math.max(nextStartTimeRef.current, outputAudioCtxRef.current.currentTime);
              const audioBuffer = await decodeAudioData(
                decode(base64Audio),
                outputAudioCtxRef.current,
                OUTPUT_SAMPLE_RATE,
                1
              );
              const source = outputAudioCtxRef.current.createBufferSource();
              source.buffer = audioBuffer;
              source.connect(outputAudioCtxRef.current.destination);
              source.start(nextStartTimeRef.current);
              nextStartTimeRef.current += audioBuffer.duration;
              audioSourcesRef.current.add(source);
              source.onended = () => audioSourcesRef.current.delete(source);
            }

            // Handle Interruption
            if (message.serverContent?.interrupted) {
              audioSourcesRef.current.forEach(s => s.stop());
              audioSourcesRef.current.clear();
              nextStartTimeRef.current = 0;
            }

            // Handle Transcriptions
            if (message.serverContent?.inputTranscription) {
              currentInputTranscription += message.serverContent.inputTranscription.text;
            }
            if (message.serverContent?.outputTranscription) {
              currentOutputTranscription += message.serverContent.outputTranscription.text;
            }

            if (message.serverContent?.turnComplete) {
              if (currentInputTranscription) {
                setTranscriptions(prev => [...prev.slice(-10), { type: 'user', text: currentInputTranscription, timestamp: Date.now() }]);
              }
              if (currentOutputTranscription) {
                setTranscriptions(prev => [...prev.slice(-10), { type: 'model', text: currentOutputTranscription, timestamp: Date.now() }]);
              }
              currentInputTranscription = '';
              currentOutputTranscription = '';
            }
          },
          onerror: (e) => {
            console.error('Session error:', e);
            setSession(prev => ({ ...prev, status: 'error', error: 'Connection lost or failed.' }));
            handleStopSession();
          },
          onclose: () => {
            console.log('Session closed');
            handleStopSession();
          }
        }
      });
      
      sessionPromiseRef.current = sessionPromise;

    } catch (err: any) {
      console.error('Failed to start session:', err);
      setSession(prev => ({ ...prev, status: 'error', error: err.message || 'Permission denied or browser incompatible.' }));
      stopAllStreams();
    }
  };

  return (
    <div className="flex flex-col h-screen bg-slate-950 text-slate-100 font-sans">
      {/* Header */}
      <header className="p-4 bg-slate-900 border-b border-slate-800 flex justify-between items-center shrink-0">
        <div className="flex items-center gap-3">
          <div className={`w-3 h-3 rounded-full ${session.status === 'connected' ? 'bg-green-500 animate-pulse' : session.status === 'connecting' ? 'bg-yellow-500 animate-pulse' : 'bg-slate-600'}`} />
          <h1 className="text-xl font-bold bg-clip-text text-transparent bg-gradient-to-r from-blue-400 to-emerald-400">
            Gemini Live Screen
          </h1>
        </div>
        <div className="flex gap-4">
          {session.isActive ? (
            <button 
              onClick={handleStopSession}
              className="px-6 py-2 bg-red-600 hover:bg-red-500 rounded-full font-medium transition-all shadow-lg shadow-red-900/20"
            >
              Stop Sharing
            </button>
          ) : (
            <button 
              onClick={startLiveSession}
              disabled={session.status === 'connecting'}
              className="px-6 py-2 bg-blue-600 hover:bg-blue-500 disabled:bg-slate-700 rounded-full font-medium transition-all shadow-lg shadow-blue-900/20"
            >
              {session.status === 'connecting' ? 'Connecting...' : 'Share Screen & Talk'}
            </button>
          )}
        </div>
      </header>

      {/* Main Content */}
      <main className="flex-1 flex overflow-hidden p-4 gap-4">
        {/* Screen Feed */}
        <div className="flex-[3] relative bg-slate-900 rounded-2xl border border-slate-800 flex items-center justify-center overflow-hidden group">
          {session.isScreenSharing ? (
            <video 
              ref={videoRef} 
              autoPlay 
              playsInline 
              muted 
              className="w-full h-full object-contain"
            />
          ) : (
            <div className="text-center p-8">
              <div className="w-20 h-20 bg-slate-800 rounded-full flex items-center justify-center mx-auto mb-4 border border-slate-700">
                <svg className="w-10 h-10 text-slate-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9.75 17L9 20l-1 1h8l-1-1-.75-3M3 13h18M5 17h14a2 2 0 002-2V5a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
                </svg>
              </div>
              <p className="text-slate-400 max-w-xs mx-auto">
                Ready to help with your live screen content. Click the button above to start.
              </p>
            </div>
          )}
          
          {/* Overlay Status */}
          {session.isActive && (
            <div className="absolute top-4 left-4 px-3 py-1 bg-black/60 backdrop-blur-md rounded-full text-xs font-mono flex items-center gap-2 border border-white/10">
              <span className="w-2 h-2 bg-red-500 rounded-full animate-ping" />
              LIVE VISION
            </div>
          )}
        </div>

        {/* Side Panel: Transcription / Status */}
        <div className="flex-1 min-w-[320px] bg-slate-900 rounded-2xl border border-slate-800 flex flex-col overflow-hidden">
          <div className="p-4 border-b border-slate-800">
            <h2 className="text-sm font-semibold uppercase tracking-wider text-slate-500">Live Transcript</h2>
          </div>
          
          <div className="flex-1 overflow-y-auto p-4 space-y-4">
            {transcriptions.length === 0 && (
              <div className="h-full flex items-center justify-center text-slate-600 text-sm italic">
                No activity yet...
              </div>
            )}
            {transcriptions.map((t, i) => (
              <div key={i} className={`flex flex-col ${t.type === 'user' ? 'items-end' : 'items-start'}`}>
                <div className={`max-w-[85%] px-4 py-3 rounded-2xl text-sm ${
                  t.type === 'user' 
                  ? 'bg-blue-600 text-white rounded-tr-none' 
                  : 'bg-slate-800 text-slate-200 rounded-tl-none border border-slate-700'
                }`}>
                  {t.text}
                </div>
                <span className="text-[10px] text-slate-600 mt-1 uppercase">
                  {t.type === 'user' ? 'You' : 'Gemini'}
                </span>
              </div>
            ))}
          </div>

          <div className="p-4 bg-slate-950/50 border-t border-slate-800">
            {session.error && (
              <div className="p-3 bg-red-950/30 border border-red-900/50 rounded-lg text-red-400 text-xs mb-3 font-medium">
                ⚠️ {session.error}
              </div>
            )}
            <div className="flex items-center gap-3 text-slate-400 text-xs">
              <div className={`w-2 h-2 rounded-full ${session.isActive ? 'bg-blue-500 shadow-[0_0_8px_rgba(59,130,246,0.5)]' : 'bg-slate-700'}`} />
              <span>Mic & Vision: {session.isActive ? 'Active' : 'Standby'}</span>
            </div>
          </div>
        </div>
      </main>

      {/* Hidden Canvas for Frame Extraction */}
      <canvas ref={canvasRef} className="hidden" />
      
      {/* Footer Info */}
      <footer className="px-6 py-3 border-t border-slate-900 text-slate-500 text-[10px] flex justify-between shrink-0">
        <div>Powered by Gemini 2.5 Flash Native Audio</div>
        <div>REAL-TIME MULTIMODAL INTERACTION</div>
      </footer>
    </div>
  );
};

export default App;
