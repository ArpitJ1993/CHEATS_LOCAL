import { dom } from './dom.js';
import { setMicrophoneButtonState, setSystemButtonState, setStopButtonEnabled, setModelDisabled, setRecordButtonEnabled, updateRecordStatus, showError, updateStatus, resetTranscriptArea } from './ui.js';
import { startSession, stopSession } from './sessions.js';
import { recorder } from './recorder.js';
import { resetTranscriptionState } from './transcription.js';
import { localTranscriptionService } from './localTranscription.js';

const state = {
  microphone: {
    stream: null,
    session: null
  },
  system: {
    stream: null,
    session: null
  }
};

function getModelValue() {
  return dom.modelSelect?.value || 'whisper-1';
}

function getMeetingsConfig() {
  return window.__meetingsConfig || {};
}

function ensureVendorSupportsAudio() {
  const config = getMeetingsConfig();
  if (config.vendorId && config.vendorId !== 'openai') {
    throw new Error(`${config.vendorLabel || 'Selected vendor'} does not support realtime meeting audio yet.`);
  }
  if (!config.apiKey) {
    throw new Error('OpenAI API key not configured. Add it in Settings.');
  }
  return config;
}

export async function startMicrophoneCapture() {
  setMicrophoneButtonState('busy');

  try {
    if (state.microphone.session) {
      await stopMicrophoneCapture();
    }

    const constraints = {
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true
      },
      video: false
    };

    const micSelect = dom.micSelect;
    let stream;
    
    // Try to use selected microphone device, but fallback to default if it fails
    if (micSelect && micSelect.value && micSelect.value !== 'default') {
      try {
        // First try with exact device ID
        constraints.audio.deviceId = { exact: micSelect.value };
        stream = await navigator.mediaDevices.getUserMedia(constraints);
      } catch (exactError) {
        console.warn('Failed to use exact device ID, trying ideal:', exactError);
        try {
          // Fallback to ideal (preferred but not required)
          constraints.audio.deviceId = { ideal: micSelect.value };
          stream = await navigator.mediaDevices.getUserMedia(constraints);
        } catch (idealError) {
          console.warn('Failed to use ideal device ID, falling back to default:', idealError);
          // Fallback to default microphone
          delete constraints.audio.deviceId;
          stream = await navigator.mediaDevices.getUserMedia(constraints);
        }
      }
    } else {
      // Use default microphone
      stream = await navigator.mediaDevices.getUserMedia(constraints);
    }
    state.microphone.stream = stream;

    // Update status to connected
    updateStatus('microphone', true);

    // Start local transcription for microphone (works independently, NO OpenAI needed)
    // This is non-blocking - if it fails, microphone still works
    localTranscriptionService.startMicrophoneTranscription(stream).catch((error) => {
      console.warn('Local microphone transcription failed (non-blocking):', error);
      // Don't show error to user - transcription is optional
    });

    // OpenAI session is NOT needed for transcription - only for Summary/Questions features
    // We skip it entirely for transcription to avoid API calls
    state.microphone.session = null;

    finalizeStart();
    setMicrophoneButtonState('running');
  } catch (error) {
    console.error('Failed to start microphone capture:', error);
    await stopMicrophoneCapture();
    setMicrophoneButtonState('idle');
    showError('microphone', error);
    throw error;
  }
}

export async function startSystemCapture() {
  setSystemButtonState('busy');
  let displayStream = null;

  try {
    if (state.system.session) {
      await stopSystemCapture();
    }

    await window.electronAPI.enableLoopbackAudio();
    displayStream = await navigator.mediaDevices.getDisplayMedia({
      audio: true,
      video: true
    });
    await window.electronAPI.disableLoopbackAudio();

    const videoTracks = displayStream.getVideoTracks();
    videoTracks.forEach((track) => {
      track.stop();
      displayStream.removeTrack(track);
    });

    state.system.stream = displayStream;

    // Update status to connected
    updateStatus('system', true);

    // Start local transcription for system audio (works independently, NO OpenAI needed)
    // This is non-blocking - if it fails, system audio still works
    localTranscriptionService.startSystemTranscription(displayStream).catch((error) => {
      console.warn('Local system audio transcription failed (non-blocking):', error);
      // Don't show error to user - transcription is optional
    });

    // OpenAI session is NOT needed for transcription - only for Summary/Questions features
    // We skip it entirely for transcription to avoid API calls
    state.system.session = null;

    finalizeStart();
    setSystemButtonState('running');
  } catch (error) {
    console.error('Failed to start system audio capture:', error);
    displayStream?.getTracks().forEach((track) => track.stop());
    await window.electronAPI.disableLoopbackAudio().catch(() => {});
    await stopSystemCapture();
    setSystemButtonState('idle');
    showError('system', error);
    throw error;
  }
}

export async function stopAllCaptures() {
  localTranscriptionService.stopAll();
  await Promise.all([stopMicrophoneCapture(), stopSystemCapture()]);
  setMicrophoneButtonState('idle');
  setSystemButtonState('idle');
  setStopButtonEnabled(false);
  setModelDisabled(false);
  setRecordButtonEnabled(false);
  updateRecordStatus(false);
  resetTranscriptionState();
}

// Expose stopAllCaptures globally for cleanup on page navigation
if (typeof window !== 'undefined') {
  window.__stopAllCaptures = stopAllCaptures;
}

export async function stopMicrophoneCapture() {
  localTranscriptionService.stopMicrophoneTranscription();
  stopSession(state.microphone.session);
  state.microphone.session = null;

  state.microphone.stream?.getTracks().forEach((track) => track.stop());
  state.microphone.stream = null;

  updateStatus('microphone', false);
  resetTranscriptArea('microphone');
  resetTranscriptionState('microphone');
  setMicrophoneButtonState('idle');
  updateRecordAvailability();
}

export async function stopSystemCapture() {
  localTranscriptionService.stopSystemTranscription();
  stopSession(state.system.session);
  state.system.session = null;

  state.system.stream?.getTracks().forEach((track) => track.stop());
  state.system.stream = null;

  await window.electronAPI.disableLoopbackAudio().catch(() => {});
  updateStatus('system', false);
  resetTranscriptArea('system');
  resetTranscriptionState('system');
  setSystemButtonState('idle');
  updateRecordAvailability();
}

export function getActiveStreams() {
  return {
    microphone: state.microphone.stream,
    system: state.system.stream
  };
}

function finalizeStart() {
  updateRecordAvailability();
}

function handleSessionError(type, error) {
  console.error(`Session error (${type})`, error);
  showError(type, error);
  if (type === 'microphone') {
    stopMicrophoneCapture();
  } else {
    stopSystemCapture();
  }
}

function updateRecordAvailability() {
  const anyActive = Boolean(state.microphone.stream || state.system.stream);
  const canRecord = Boolean(state.microphone.stream && state.system.stream);

  setStopButtonEnabled(anyActive);
  setModelDisabled(anyActive);
  setRecordButtonEnabled(canRecord);
  if (!canRecord && recorder.isRecording) {
    recorder.stopRecording();
    updateRecordStatus(false);
  }
}


