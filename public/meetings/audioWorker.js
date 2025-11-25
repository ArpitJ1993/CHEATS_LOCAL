/**
 * Web Worker for Audio Processing
 * Handles PCM conversion, silence detection, and buffer management
 * Runs in background thread to avoid blocking main thread
 */

// Configuration
const MIN_AUDIO_ENERGY = 0.005; // Minimum RMS energy to consider as speech
const SAMPLE_RATE = 16000;

/**
 * Calculate RMS (Root Mean Square) energy of audio buffer
 */
function calculateRMS(buffer) {
  let sumSquares = 0;
  for (let i = 0; i < buffer.length; i++) {
    sumSquares += buffer[i] * buffer[i];
  }
  return Math.sqrt(sumSquares / buffer.length);
}

/**
 * Check if audio buffer contains speech
 */
function hasSpeech(buffer) {
  const rms = calculateRMS(buffer);
  return {
    hasSpeech: rms > MIN_AUDIO_ENERGY,
    energy: rms
  };
}

/**
 * Convert Float32 PCM to Int16 PCM
 */
function float32ToInt16(float32Buffer) {
  const int16Buffer = new Int16Array(float32Buffer.length);
  for (let i = 0; i < float32Buffer.length; i++) {
    // Clamp sample to [-1, 1] range
    const sample = Math.max(-1, Math.min(1, float32Buffer[i]));
    // Convert to Int16: multiply by 32767 for positive, 32768 for negative
    // This ensures symmetric range: [-32768, 32767]
    int16Buffer[i] = sample < 0 ? Math.round(sample * 0x8000) : Math.round(sample * 0x7FFF);
  }
  return int16Buffer;
}

/**
 * Create WAV header for PCM data
 */
function createWAVHeader(dataLength, sampleRate, channels, bitsPerSample) {
  const header = new ArrayBuffer(44);
  const view = new DataView(header);
  
  // RIFF header
  const writeString = (offset, string) => {
    for (let i = 0; i < string.length; i++) {
      view.setUint8(offset + i, string.charCodeAt(i));
    }
  };
  
  writeString(0, 'RIFF');
  view.setUint32(4, 36 + dataLength, true); // File size - 8
  writeString(8, 'WAVE');
  writeString(12, 'fmt ');
  view.setUint32(16, 16, true); // fmt chunk size
  view.setUint16(20, 1, true); // Audio format (PCM)
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * channels * bitsPerSample / 8, true); // Byte rate
  view.setUint16(32, channels * bitsPerSample / 8, true); // Block align
  view.setUint16(34, bitsPerSample, true);
  writeString(36, 'data');
  view.setUint32(40, dataLength, true);
  
  return header;
}

/**
 * Convert Float32 PCM buffer to WAV format
 */
function convertToWAV(float32Buffer, sampleRate = SAMPLE_RATE) {
  // Convert to Int16
  const int16Buffer = float32ToInt16(float32Buffer);
  
  // Create WAV header
  const dataLength = int16Buffer.length * 2; // 2 bytes per sample
  const header = createWAVHeader(dataLength, sampleRate, 1, 16);
  
  // Combine header and data
  const wavBuffer = new ArrayBuffer(header.byteLength + int16Buffer.byteLength);
  const wavView = new Uint8Array(wavBuffer);
  wavView.set(new Uint8Array(header), 0);
  wavView.set(new Uint8Array(int16Buffer.buffer), header.byteLength);
  
  return wavBuffer;
}

// Handle messages from main thread
self.onmessage = function(e) {
  const { type, data, id, buffer } = e.data;
  
  try {
    switch (type) {
      case 'check_speech':
        // Check if audio buffer contains speech
        const speechResult = hasSpeech(data.buffer);
        self.postMessage({
          type: 'speech_result',
          id: id,
          hasSpeech: speechResult.hasSpeech,
          energy: speechResult.energy
        });
        break;
        
      case 'convert_pcm':
        // Convert Float32 PCM to Int16 PCM
        const int16Buffer = float32ToInt16(data.buffer);
        self.postMessage({
          type: 'pcm_result',
          id: id,
          buffer: int16Buffer.buffer,
          length: int16Buffer.length
        }, [int16Buffer.buffer]); // Transfer ownership
        break;
        
      case 'convert_wav':
        // Convert Float32 PCM to WAV format
        const wavBuffer = convertToWAV(data.buffer, data.sampleRate || SAMPLE_RATE);
        self.postMessage({
          type: 'wav_result',
          id: id,
          buffer: wavBuffer,
          length: wavBuffer.byteLength
        }, [wavBuffer]); // Transfer ownership
        break;
        
      case 'process_buffer':
        // Complete processing: check speech, convert to Int16
        // Note: buffer is sent directly in the message, not nested in data
        if (!buffer) {
          throw new Error('Buffer is required for process_buffer');
        }
        const speechCheck = hasSpeech(buffer);
        if (speechCheck.hasSpeech) {
          const int16Buffer = float32ToInt16(buffer);
          self.postMessage({
            type: 'processed_buffer',
            id: id,
            buffer: int16Buffer.buffer,
            length: int16Buffer.length,
            energy: speechCheck.energy
          }, [int16Buffer.buffer]); // Transfer ownership
        } else {
          self.postMessage({
            type: 'silent_buffer',
            id: id,
            energy: speechCheck.energy
          });
        }
        break;
        
      default:
        self.postMessage({
          type: 'error',
          id: id,
          error: `Unknown message type: ${type}`
        });
    }
  } catch (error) {
    self.postMessage({
      type: 'error',
      id: id,
      error: error.message
    });
  }
};




