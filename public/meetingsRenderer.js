import { dom } from './meetings/dom.js';
import { initializeUi, setMicrophoneButtonState, setSystemButtonState, setStopButtonEnabled, setModelDisabled, setRecordButtonEnabled, updateRecordStatus, showError } from './meetings/ui.js';
import { startMicrophoneCapture, startSystemCapture, stopMicrophoneCapture, stopSystemCapture, stopAllCaptures, getActiveStreams } from './meetings/streams.js';
import { recorder } from './meetings/recorder.js';
import './meetings/localTranscription.js';

// Always refresh microphone options when script loads (even if already initialized)
async function refreshMicrophoneOptions() {
  try {
    const micSelect = dom.micSelect;
    if (!micSelect) return;

    const selected = micSelect.value;
    
    // Enumerate devices first
    let devices = await navigator.mediaDevices.enumerateDevices();
    let audioInputs = devices.filter((device) => device.kind === 'audioinput');
    
    // If device labels are empty, try requesting permission to get labels
    // (This only happens if permission hasn't been granted yet)
    const hasLabels = audioInputs.some(device => device.label && device.label.trim() !== '');
    if (!hasLabels && audioInputs.length > 0) {
      try {
        // Request permission to get device labels
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        // Stop the stream immediately - we just needed permission
        stream.getTracks().forEach(track => track.stop());
        // Re-enumerate to get labels
        devices = await navigator.mediaDevices.enumerateDevices();
        audioInputs = devices.filter((device) => device.kind === 'audioinput');
      } catch (err) {
        // Permission denied - continue with device IDs only
        console.debug('Microphone permission not granted, using device IDs');
      }
    }
    
    micSelect.innerHTML = '';

    if (audioInputs.length === 0) {
      const option = document.createElement('option');
      option.value = '';
      option.textContent = 'No microphones found';
      option.disabled = true;
      micSelect.appendChild(option);
    } else {
      audioInputs.forEach((device, index) => {
        const option = document.createElement('option');
        option.value = device.deviceId;
        option.textContent = device.label || `Microphone ${index + 1}`;
        micSelect.appendChild(option);
      });
    }

    // Restore previous selection if it still exists
    if (selected) {
      const optionExists = Array.from(micSelect.options).some(opt => opt.value === selected);
      if (optionExists) {
        micSelect.value = selected;
      }
    }
  } catch (error) {
    console.error('Failed to enumerate audio devices:', error);
    const micSelect = dom.micSelect;
    if (micSelect) {
      micSelect.innerHTML = '';
      const option = document.createElement('option');
      option.value = '';
      option.textContent = 'Error loading microphones';
      option.disabled = true;
      micSelect.appendChild(option);
    }
  }
}

// Expose refresh function globally so it can be called from React component
window.__refreshMicrophoneOptions = refreshMicrophoneOptions;

// Store event listeners so we can remove them
let eventListeners = {
  micBtn: null,
  stopMicBtn: null,
  systemBtn: null,
  stopSystemBtn: null,
  stopBtn: null,
  recordBtn: null,
  deviceChange: null,
  beforeUnload: null
};

// Function to remove all event listeners
function removeEventListeners() {
  const micBtn = dom.startMicBtn;
  const stopMicBtn = dom.stopMicBtn;
  const systemBtn = dom.startSystemBtn;
  const stopSystemBtn = dom.stopSystemBtn;
  const stopBtn = dom.stopBtn;
  const recordBtn = dom.recordBtn;

  if (micBtn && eventListeners.micBtn) {
    micBtn.removeEventListener('click', eventListeners.micBtn);
    eventListeners.micBtn = null;
  }
  if (stopMicBtn && eventListeners.stopMicBtn) {
    stopMicBtn.removeEventListener('click', eventListeners.stopMicBtn);
    eventListeners.stopMicBtn = null;
  }
  if (systemBtn && eventListeners.systemBtn) {
    systemBtn.removeEventListener('click', eventListeners.systemBtn);
    eventListeners.systemBtn = null;
  }
  if (stopSystemBtn && eventListeners.stopSystemBtn) {
    stopSystemBtn.removeEventListener('click', eventListeners.stopSystemBtn);
    eventListeners.stopSystemBtn = null;
  }
  if (stopBtn && eventListeners.stopBtn) {
    stopBtn.removeEventListener('click', eventListeners.stopBtn);
    eventListeners.stopBtn = null;
  }
  if (recordBtn && eventListeners.recordBtn) {
    recordBtn.removeEventListener('click', eventListeners.recordBtn);
    eventListeners.recordBtn = null;
  }
  if (eventListeners.deviceChange && navigator?.mediaDevices?.removeEventListener) {
    navigator.mediaDevices.removeEventListener('devicechange', eventListeners.deviceChange);
    eventListeners.deviceChange = null;
  }
  if (eventListeners.beforeUnload) {
    window.removeEventListener('beforeunload', eventListeners.beforeUnload);
    eventListeners.beforeUnload = null;
  }
}

// Expose re-initialization function
window.__reinitializeMeetingsRenderer = async function() {
  console.debug('Re-initializing meetings renderer');
  removeEventListeners();
  await initialize();
};

// Initialize on first load
if (!window.__meetingsRendererLoaded) {
  window.__meetingsRendererLoaded = true;
  initialize();
} else {
  // If already loaded, re-initialize to ensure event listeners are attached
  console.debug('meetingsRenderer already loaded; re-initializing');
  setTimeout(() => {
    if (window.__reinitializeMeetingsRenderer) {
      window.__reinitializeMeetingsRenderer();
    }
  }, 0);
}

async function initialize() {
  initializeUi();
  await refreshMicrophoneOptions();
  attachEventListeners();

  if (navigator?.mediaDevices?.addEventListener && eventListeners.deviceChange) {
    navigator.mediaDevices.addEventListener('devicechange', eventListeners.deviceChange);
  }

  if (eventListeners.beforeUnload) {
    window.addEventListener('beforeunload', eventListeners.beforeUnload);
  }
}

function attachEventListeners() {
  // Remove any existing listeners first
  removeEventListeners();
  
  const micBtn = dom.startMicBtn;
  const stopMicBtn = dom.stopMicBtn;
  const systemBtn = dom.startSystemBtn;
  const stopSystemBtn = dom.stopSystemBtn;
  const stopBtn = dom.stopBtn;
  const recordBtn = dom.recordBtn;

  // Create handler functions and store references
  const micBtnHandler = async () => {
    try {
      await startMicrophoneCapture();
        } catch (error) {
      console.error('Microphone start failed:', error);
    }
  };
  
  const stopMicBtnHandler = async () => {
    try {
      await stopMicrophoneCapture();
    } catch (error) {
      console.error('Microphone stop failed:', error);
    }
  };
  
  const systemBtnHandler = async () => {
    try {
      await startSystemCapture();
        } catch (error) {
      console.error('System audio start failed:', error);
    }
  };
  
  const stopSystemBtnHandler = async () => {
    try {
      await stopSystemCapture();
    } catch (error) {
      console.error('System audio stop failed:', error);
    }
  };
  
  const stopBtnHandler = async () => {
    await stopAllCaptures();
    setMicrophoneButtonState('idle');
    setSystemButtonState('idle');
    setStopButtonEnabled(false);
    setModelDisabled(false);
    setRecordButtonEnabled(false);
    updateRecordStatus(false);
  };

  // Attach listeners and store references
  if (micBtn) {
    micBtn.addEventListener('click', micBtnHandler);
    eventListeners.micBtn = micBtnHandler;
  }
  
  if (stopMicBtn) {
    stopMicBtn.addEventListener('click', stopMicBtnHandler);
    eventListeners.stopMicBtn = stopMicBtnHandler;
  }
  
  if (systemBtn) {
    systemBtn.addEventListener('click', systemBtnHandler);
    eventListeners.systemBtn = systemBtnHandler;
  }
  
  if (stopSystemBtn) {
    stopSystemBtn.addEventListener('click', stopSystemBtnHandler);
    eventListeners.stopSystemBtn = stopSystemBtnHandler;
  }
  
  if (stopBtn) {
    stopBtn.addEventListener('click', stopBtnHandler);
    eventListeners.stopBtn = stopBtnHandler;
  }

  if (recordBtn) {
    recordBtn.disabled = true;
    const recordBtnHandler = toggleRecording;
    recordBtn.addEventListener('click', recordBtnHandler);
    eventListeners.recordBtn = recordBtnHandler;
  }
  
  // Store device change listener
  if (navigator?.mediaDevices?.addEventListener) {
    eventListeners.deviceChange = refreshMicrophoneOptions;
  }
  
  // Store beforeunload listener
  const beforeUnloadHandler = () => {
    stopAllCaptures().catch(() => {});
  };
  eventListeners.beforeUnload = beforeUnloadHandler;
}

async function toggleRecording() {
  if (recorder.isRecording) {
    recorder.stopRecording();
    updateRecordStatus(false);
        return;
    }

  const { microphone, system } = getActiveStreams();
  if (!microphone || !system) {
    showError('microphone', new Error('Start both microphone and system audio before recording.'));
        return;
    }

  try {
    await recorder.startRecording(microphone, system);
    updateRecordStatus(true);
    } catch (error) {
    console.error('Failed to start recording:', error);
    showError('microphone', error);
        updateRecordStatus(false);
    }
}

