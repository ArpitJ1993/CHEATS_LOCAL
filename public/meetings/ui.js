import { dom } from './dom.js';

const STATUS_LABELS = {
  microphone: 'Microphone',
  system: 'System Audio'
};

export function initializeUi() {
  setMicrophoneButtonState('idle');
  setSystemButtonState('idle');
  setStopButtonEnabled(false);
  setModelDisabled(false);
  setRecordButtonEnabled(false);
  updateRecordStatus(false);
  updateStatus('microphone', false);
  updateStatus('system', false);
  resetTranscriptArea('microphone');
  resetTranscriptArea('system');
  
  // Initialize stop buttons as disabled
  const stopMicBtn = dom.stopMicBtn;
  const stopSystemBtn = dom.stopSystemBtn;
  if (stopMicBtn) stopMicBtn.disabled = true;
  if (stopSystemBtn) stopSystemBtn.disabled = true;
}

export function setMicrophoneButtonState(state) {
  const startBtn = dom.startMicBtn;
  const stopBtn = dom.stopMicBtn;
  
  if (startBtn) {
    switch (state) {
      case 'busy':
        startBtn.disabled = true;
        break;
      case 'running':
        startBtn.disabled = false;
        startBtn.textContent = 'Start Microphone';
        break;
      default:
        startBtn.disabled = false;
        startBtn.textContent = 'Start Microphone';
    }
  }
  
  if (stopBtn) {
    stopBtn.disabled = state !== 'running';
  }
}

export function setSystemButtonState(state) {
  const startBtn = dom.startSystemBtn;
  const stopBtn = dom.stopSystemBtn;
  
  if (startBtn) {
    switch (state) {
      case 'busy':
        startBtn.disabled = true;
        break;
      case 'running':
        startBtn.disabled = false;
        startBtn.textContent = 'Start System Audio';
        break;
      default:
        startBtn.disabled = false;
        startBtn.textContent = 'Start System Audio';
    }
  }
  
  if (stopBtn) {
    stopBtn.disabled = state !== 'running';
  }
}

export function setStopButtonEnabled(enabled) {
  const btn = dom.stopBtn;
  if (btn) {
    btn.disabled = !enabled;
  }
}

export function setModelDisabled(disabled) {
  const select = dom.modelSelect;
  if (select) {
    select.disabled = disabled;
  }
}

export function updateStatus(type, isConnected) {
  const element = type === 'microphone' ? dom.micStatus : dom.speakerStatus;
  const label = STATUS_LABELS[type] || 'Audio';
  if (!element) {
    console.warn(`Status element not found for ${type}`);
    return;
  }

  const statusText = isConnected ? 'Connected' : 'Disconnected';
  const fullText = `${label}: ${statusText}`;

  // Material-UI Chip renders the label in a span or as text content
  // Try multiple methods to update it
  try {
    // Method 1: Update the label attribute (for Material-UI)
    element.setAttribute('label', fullText);
    
    // Method 2: Find and update text content directly
    const textNode = Array.from(element.childNodes).find(node => 
      node.nodeType === Node.TEXT_NODE || node.nodeName === 'SPAN'
    );
    if (textNode) {
      if (textNode.nodeType === Node.TEXT_NODE) {
        textNode.textContent = fullText;
      } else if (textNode.textContent !== undefined) {
        textNode.textContent = fullText;
      }
    }
    
    // Method 3: Update textContent of the element itself
    if (element.textContent !== undefined) {
      // Only update if it's not a Material-UI component that manages its own content
      const currentText = element.textContent.trim();
      if (currentText && !currentText.includes('Connected') && !currentText.includes('Disconnected')) {
        // It might be a regular element, update directly
        element.textContent = fullText;
      }
    }
    
    // Update className for styling
    if (isConnected) {
      element.className = 'status connected';
      element.classList.add('connected');
      element.classList.remove('disconnected');
    } else {
      element.className = 'status disconnected';
      element.classList.add('disconnected');
      element.classList.remove('connected');
    }
    
    console.log(`Status updated: ${type} = ${statusText}`);
  } catch (error) {
    console.error(`Error updating status for ${type}:`, error);
  }
}

export function appendTranscript(type, transcript) {
  const target = type === 'microphone' ? dom.micResults : dom.speakerResults;
  if (!target) return;

  const text = transcript.transcript;
  if (!text) return;

  const timestamp = new Date().toLocaleTimeString();
  const prefix = transcript.partial ? '' : `[${timestamp}]`;

  target.textContent += `${prefix} ${text}\n`;
  target.scrollTop = target.scrollHeight;
  target.setAttribute('data-last-update', Date.now().toString());
}

export function resetTranscriptArea(type) {
  const target = type === 'microphone' ? dom.micResults : dom.speakerResults;
  if (!target) return;
  const timestamp = new Date().toLocaleTimeString();
  const waitingMessage = type === 'microphone'
    ? `[${timestamp}] Waiting for microphone input...\n`
    : `[${timestamp}] Waiting for system audio...\n`;
  target.textContent = waitingMessage;
  target.setAttribute('data-last-update', Date.now().toString());
}

export function showError(type, error) {
  const label = STATUS_LABELS[type] || 'Audio';
  const message = error?.message || String(error);
  alert(`Error (${label}): ${message}`);
}

export function updateRecordStatus(isRecording) {
  const recordStatus = dom.recordStatus;
  const recordBtn = dom.recordBtn;

  if (recordStatus) {
    if (isRecording) {
      recordStatus.textContent = 'Recording: Active';
      recordStatus.className = 'status connected';
    } else {
      recordStatus.textContent = 'Recording: Stopped';
      recordStatus.className = 'status disconnected';
    }
  }

  if (recordBtn) {
    recordBtn.textContent = isRecording ? 'Stop Recording' : 'Start Recording';
  }
}

export function setRecordButtonEnabled(enabled) {
  const recordBtn = dom.recordBtn;
  if (recordBtn) {
    recordBtn.disabled = !enabled;
  }
  if (!enabled) {
    updateRecordStatus(false);
  }
}

export function setRecordButtonVisibility(visible) {
  const recordBtn = dom.recordBtn;
  if (recordBtn) {
    recordBtn.style.display = visible ? 'inline-block' : 'none';
  }
}


