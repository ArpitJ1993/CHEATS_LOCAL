/**
 * Real-Time Local Transcription Service using AudioContext + HTTP POST (Hybrid Approach)
 * Uses AudioContext for reliable PCM capture (like old implementation)
 * Sends via HTTP POST for reliability (like landing page)
 * Accumulates 5 second chunks with overlap for better accuracy
 */

const WHISPER_HTTP_URL = 'http://localhost:8765/transcribe';
const SAMPLE_RATE = 16000; // Whisper requires 16kHz
const CHUNK_DURATION_MS = 5000; // 5 seconds
const SAMPLES_PER_CHUNK = Math.floor((SAMPLE_RATE * CHUNK_DURATION_MS) / 1000); // 80000 samples
const OVERLAP_DURATION_MS = 1000; // 1 second overlap
const OVERLAP_SAMPLES = Math.floor((SAMPLE_RATE * OVERLAP_DURATION_MS) / 1000); // 16000 samples
const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 500;

class LocalTranscriptionService {
  constructor() {
    // Audio context and sources
    this.audioContext = null;
    this.microphoneSource = null;
    this.systemSource = null;
    this.microphoneProcessor = null;
    this.systemProcessor = null;
    
    // PCM buffers (Float32 arrays)
    this.microphoneBuffer = new Float32Array(0);
    this.systemBuffer = new Float32Array(0);
    
    // Processing state
    this.microphoneProcessing = false;
    this.systemProcessing = false;
    this.microphoneRecording = false;
    this.systemRecording = false;
    
    // Retry and health tracking
    this.microphoneRetryCount = 0;
    this.systemRetryCount = 0;
    this.lastSuccessTime = {
      microphone: Date.now(),
      system: Date.now()
    };
    
    // Deduplication
    this.lastTranscription = {
      microphone: { text: '', timestamp: 0 },
      system: { text: '', timestamp: 0 }
    };
    
    // Accumulated transcripts for summary/questions
    this.accumulatedTranscript = {
      microphone: [],
      system: []
    };
  }

  float32ToInt16PCM(float32Array) {
    const int16Array = new Int16Array(float32Array.length);
    for (let i = 0; i < float32Array.length; i++) {
      const sample = Math.max(-1, Math.min(1, float32Array[i]));
      // Convert Float32 [-1, 1] to Int16 [-32768, 32767]
      // Use symmetric conversion: multiply by 32767 and clamp
      int16Array[i] = Math.max(-32768, Math.min(32767, Math.round(sample * 32767)));
    }
    return int16Array;
  }

  async transcribeAudioChunk(pcmInt16Array, sourceType, retryCount = 0) {
    try {
      // Validate audio data - check for minimum size and audio energy
      if (pcmInt16Array.length < 1000) {
        // Too small to process
        return null;
      }
      
      // Quick silence check before sending to server
      let sumSquares = 0;
      for (let i = 0; i < Math.min(pcmInt16Array.length, 1000); i++) {
        const sample = pcmInt16Array[i] / 32768.0; // Normalize to [-1, 1]
        sumSquares += sample * sample;
      }
      const rms = Math.sqrt(sumSquares / Math.min(pcmInt16Array.length, 1000));
      if (rms < 0.005) {
        // Very quiet, likely silence - skip transcription
        return null;
    }

      // Convert Int16Array to ArrayBuffer
      // Important: Use slice to ensure we only send the actual Int16Array data
      // If the Int16Array is a view into a larger buffer, we need to extract just its portion
      const pcmBuffer = pcmInt16Array.buffer.slice(
        pcmInt16Array.byteOffset,
        pcmInt16Array.byteOffset + pcmInt16Array.byteLength
      );
      
      const response = await fetch(WHISPER_HTTP_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/octet-stream', // PCM data
          'Content-Length': pcmBuffer.byteLength.toString()
        },
        body: pcmBuffer
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      const result = await response.json();
      
      // Handle response - success with empty text means silence (not an error)
      if (result.success) {
        // Reset retry count on successful response (even if text is empty)
        if (sourceType === 'microphone') {
          this.microphoneRetryCount = 0;
          this.lastSuccessTime.microphone = Date.now();
        } else {
          this.systemRetryCount = 0;
          this.lastSuccessTime.system = Date.now();
        }
        
        // Return text if available, null if empty (silence)
        if (result.text && result.text.trim()) {
          return result.text.trim();
        } else {
          // Empty text means silence - not an error, just return null
          return null;
        }
      } else {
        // Server returned success: false - this is an actual error
        throw new Error(result.error || 'Transcription failed');
            }
          } catch (error) {
      // Only log and retry on actual errors, not silence
      const isSilenceError = error.message && error.message.includes('No transcription text returned');
      
      if (!isSilenceError) {
        console.error(`Transcription error for ${sourceType} (attempt ${retryCount + 1}):`, error);
        
        // Retry logic for actual errors
        if (retryCount < MAX_RETRIES) {
          await new Promise(resolve => setTimeout(resolve, RETRY_DELAY_MS * (retryCount + 1)));
          return this.transcribeAudioChunk(pcmInt16Array, sourceType, retryCount + 1);
        }
        
        // Max retries reached
        if (sourceType === 'microphone') {
          this.microphoneRetryCount++;
        } else {
          this.systemRetryCount++;
        }
        
        // Check if server is down (no success in last 30 seconds)
        const timeSinceLastSuccess = Date.now() - this.lastSuccessTime[sourceType];
        if (timeSinceLastSuccess > 30000) {
          console.warn(`Whisper server may be down for ${sourceType}. Last success: ${timeSinceLastSuccess}ms ago`);
        }
      }
      
      // Return null for silence or errors (don't throw)
      return null;
    }
  }

  async processChunk(float32Buffer, sourceType) {
    if (float32Buffer.length === 0) return;
    
    // Validate minimum buffer size
    if (float32Buffer.length < 1000) {
      return; // Too small to process
    }
    
    const processingKey = sourceType === 'microphone' ? 'microphoneProcessing' : 'systemProcessing';
    
    // Prevent concurrent processing
    if (this[processingKey]) {
      return;
    }
    
    this[processingKey] = true;
    
    try {
      // Convert Float32 to Int16 PCM
      const int16PCM = this.float32ToInt16PCM(float32Buffer);
      
      // Transcribe (returns null for silence, text for speech)
      const text = await this.transcribeAudioChunk(int16PCM, sourceType);
      
      if (text) {
          // Deduplication - only dispatch if different
          const lastTrans = this.lastTranscription[sourceType];
          const timeSinceLast = Date.now() - lastTrans.timestamp;
          
          // Only update if text is different or enough time has passed
          if (text !== lastTrans.text && timeSinceLast > 500) {
            this.lastTranscription[sourceType] = { text, timestamp: Date.now() };
            
            // Accumulate transcript with deduplication
            this.accumulateTranscript(sourceType, text);
            
            this.dispatchTranscription(sourceType, text);
          }
        }
      // If text is null, it means silence - that's fine, just don't dispatch
    } catch (error) {
      // Only log unexpected errors (not silence-related)
      if (!error.message || !error.message.includes('silence')) {
        console.error(`Error processing chunk for ${sourceType}:`, error);
      }
    } finally {
      this[processingKey] = false;
    }
  }

  processFullBuffer(sourceType) {
    const bufferKey = sourceType === 'microphone' ? 'microphoneBuffer' : 'systemBuffer';
    const buffer = this[bufferKey];
    
    // Check if we have enough samples for a chunk
    if (buffer.length >= SAMPLES_PER_CHUNK) {
      // Extract chunk to process
      const chunkToProcess = buffer.slice(0, SAMPLES_PER_CHUNK);
      
      // Keep overlap for next chunk
      const remaining = buffer.slice(SAMPLES_PER_CHUNK - OVERLAP_SAMPLES);
      this[bufferKey] = remaining;
      
      // Process chunk asynchronously (don't await - fire and forget for real-time)
      this.processChunk(chunkToProcess, sourceType);
    }
  }

  async startMicrophoneTranscription(stream) {
    if (this.microphoneSource) {
      this.stopMicrophoneTranscription();
    }

    try {
      // Create AudioContext for PCM capture
      this.audioContext = new (window.AudioContext || window.webkitAudioContext)({
        sampleRate: SAMPLE_RATE
      });
      
      // Create audio source from stream
      this.microphoneSource = this.audioContext.createMediaStreamSource(stream);
      
      // Create ScriptProcessorNode for real-time PCM capture
      const bufferSize = 4096;
      this.microphoneProcessor = this.audioContext.createScriptProcessor(bufferSize, 1, 1);
      
      // Reset buffer
      this.microphoneBuffer = new Float32Array(0);
      this.microphoneRecording = true;
      this.microphoneRetryCount = 0;
      this.lastSuccessTime.microphone = Date.now();
      
      this.microphoneProcessor.onaudioprocess = (event) => {
        if (!this.microphoneRecording) return;
        
        const inputData = event.inputBuffer.getChannelData(0);
        
        // Append to buffer
        const newBuffer = new Float32Array(this.microphoneBuffer.length + inputData.length);
        newBuffer.set(this.microphoneBuffer);
        newBuffer.set(inputData, this.microphoneBuffer.length);
        this.microphoneBuffer = newBuffer;
        
        // Check if buffer is full and process if needed
        this.processFullBuffer('microphone');
      };
      
      // Connect audio processing chain
      this.microphoneSource.connect(this.microphoneProcessor);
      this.microphoneProcessor.connect(this.audioContext.destination);
      
      console.log('Microphone transcription started (AudioContext + HTTP POST)');
      
    } catch (error) {
      console.error('Failed to start microphone transcription:', error);
      this.microphoneRecording = false;
      throw error;
    }
  }

  async startSystemTranscription(stream) {
    if (this.systemSource) {
      this.stopSystemTranscription();
    }

    try {
      // Create AudioContext if not exists
      if (!this.audioContext) {
        this.audioContext = new (window.AudioContext || window.webkitAudioContext)({
          sampleRate: SAMPLE_RATE
        });
      }
      
      // Create audio source from stream
      this.systemSource = this.audioContext.createMediaStreamSource(stream);
      
      // Create ScriptProcessorNode for real-time PCM capture
      const bufferSize = 4096;
      this.systemProcessor = this.audioContext.createScriptProcessor(bufferSize, 1, 1);
      
      // Reset buffer
      this.systemBuffer = new Float32Array(0);
      this.systemRecording = true;
      this.systemRetryCount = 0;
      this.lastSuccessTime.system = Date.now();
      
      this.systemProcessor.onaudioprocess = (event) => {
        if (!this.systemRecording) return;
        
        const inputData = event.inputBuffer.getChannelData(0);
        
        // Append to buffer
        const newBuffer = new Float32Array(this.systemBuffer.length + inputData.length);
        newBuffer.set(this.systemBuffer);
        newBuffer.set(inputData, this.systemBuffer.length);
        this.systemBuffer = newBuffer;
        
        // Check if buffer is full and process if needed
        this.processFullBuffer('system');
      };
      
      // Connect audio processing chain
      this.systemSource.connect(this.systemProcessor);
      this.systemProcessor.connect(this.audioContext.destination);
      
      console.log('System audio transcription started (AudioContext + HTTP POST)');
      
    } catch (error) {
      console.error('Failed to start system audio transcription:', error);
      this.systemRecording = false;
      throw error;
    }
  }

  accumulateTranscript(sourceType, text) {
    // Add new text to accumulated transcript with deduplication
    const transcriptArray = this.accumulatedTranscript[sourceType];
    
    // Simple deduplication: don't add if the last entry is the same
    if (transcriptArray.length === 0 || transcriptArray[transcriptArray.length - 1] !== text) {
      transcriptArray.push(text);
      
      // Limit transcript size to prevent memory issues (keep last 1000 entries per source)
      if (transcriptArray.length > 1000) {
        transcriptArray.shift();
      }
    }
  }

  getFullTranscript() {
    // Combine microphone and system transcripts
    const micText = this.accumulatedTranscript.microphone.join(' ');
    const sysText = this.accumulatedTranscript.system.join(' ');
    
    // Format: separate by source, or combine if both exist
    if (micText && sysText) {
      return `MIC: ${micText}\n\nSYSTEM: ${sysText}`;
    } else if (micText) {
      return micText;
    } else if (sysText) {
      return sysText;
    }
    return '';
  }

  resetTranscript() {
    this.accumulatedTranscript.microphone = [];
    this.accumulatedTranscript.system = [];
  }

  dispatchTranscription(source, text) {
    try {
      const event = new CustomEvent('local-transcription', {
        detail: { source, text },
        bubbles: true,
        cancelable: true
      });
      window.dispatchEvent(event);
    } catch (error) {
      console.error('Error dispatching transcription event:', error);
    }
  }

  stopMicrophoneTranscription() {
    this.microphoneRecording = false;
    
    if (this.microphoneProcessor) {
      try {
        this.microphoneProcessor.disconnect();
      } catch (e) {
        // Ignore
      }
      this.microphoneProcessor = null;
    }
    
    if (this.microphoneSource) {
      try {
        this.microphoneSource.disconnect();
      } catch (e) {
        // Ignore
      }
      this.microphoneSource = null;
    }
    
    if (this.audioContext && this.audioContext.state !== 'closed' && !this.systemRecording) {
      this.audioContext.close().catch(e => {
        console.warn('Error closing audio context:', e);
      });
      this.audioContext = null;
    }

    // Process any remaining buffer
    if (this.microphoneBuffer.length > 0) {
      this.processChunk(this.microphoneBuffer, 'microphone');
      this.microphoneBuffer = new Float32Array(0);
    }
    
    this.microphoneProcessing = false;
    console.log('Microphone transcription stopped');
  }
  
  // Expose methods globally for React components
  static getInstance() {
    return localTranscriptionService;
  }

  stopSystemTranscription() {
    this.systemRecording = false;
    
    if (this.systemProcessor) {
      try {
        this.systemProcessor.disconnect();
      } catch (e) {
        // Ignore
      }
      this.systemProcessor = null;
    }
    
    if (this.systemSource) {
      try {
        this.systemSource.disconnect();
      } catch (e) {
        // Ignore
      }
      this.systemSource = null;
    }
    
    if (this.audioContext && this.audioContext.state !== 'closed' && !this.microphoneRecording) {
      this.audioContext.close().catch(e => {
        console.warn('Error closing audio context:', e);
      });
      this.audioContext = null;
    }

    // Process any remaining buffer
    if (this.systemBuffer.length > 0) {
      this.processChunk(this.systemBuffer, 'system');
      this.systemBuffer = new Float32Array(0);
    }
    
    this.systemProcessing = false;
    console.log('System audio transcription stopped');
  }

  stopAll() {
    this.stopMicrophoneTranscription();
    this.stopSystemTranscription();
  }
}

export const localTranscriptionService = new LocalTranscriptionService();

// Expose globally for React components
if (typeof window !== 'undefined') {
  window.__localTranscriptionService = localTranscriptionService;
}
