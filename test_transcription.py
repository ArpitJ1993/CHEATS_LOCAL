#!/usr/bin/env python3
"""
Test script to verify end-to-end transcription flow
"""
import os
import numpy as np
import wave
import tempfile
import json
from faster_whisper import WhisperModel
from urllib.request import urlopen, Request

# Generate test PCM audio (1 second of 440Hz sine wave at 16kHz)
SAMPLE_RATE = 16000
DURATION = 1.0  # 1 second
FREQUENCY = 440  # A4 note

# Generate sine wave
num_samples = int(SAMPLE_RATE * DURATION)
t = np.linspace(0, DURATION, num_samples, False)
audio_float32 = np.sin(2 * np.pi * FREQUENCY * t).astype(np.float32)

# Convert to Int16 PCM
audio_int16 = (audio_float32 * 32767).astype(np.int16)
audio_bytes = audio_int16.tobytes()

print(f"Generated test audio: {len(audio_bytes)} bytes, {num_samples} samples")
print(f"Audio range: {audio_int16.min()} to {audio_int16.max()}")

# Test 1: Create WAV file directly
print("\n=== Test 1: Creating WAV file ===")
wav_path = tempfile.NamedTemporaryFile(delete=False, suffix='.wav', prefix='test_').name
try:
    with wave.open(wav_path, 'wb') as wav_file:
        wav_file.setnchannels(1)
        wav_file.setsampwidth(2)
        wav_file.setframerate(SAMPLE_RATE)
        wav_file.writeframes(audio_bytes)
    
    print(f"✓ WAV file created: {wav_path}")
    print(f"  File size: {os.path.getsize(wav_path)} bytes")
    
    # Verify WAV file
    with wave.open(wav_path, 'rb') as test_wav:
        print(f"  Channels: {test_wav.getnchannels()}")
        print(f"  Sample width: {test_wav.getsampwidth()}")
        print(f"  Sample rate: {test_wav.getframerate()}")
        print(f"  Frames: {test_wav.getnframes()}")
    
    # Test 2: Try to transcribe with faster-whisper
    print("\n=== Test 2: Transcribing with faster-whisper ===")
    model = WhisperModel("small.en", device="cpu", compute_type="int8")
    segments, info = model.transcribe(wav_path, language="en", beam_size=1)
    
    text_parts = []
    for segment in segments:
        text_parts.append(segment.text.strip())
    
    result_text = " ".join(text_parts).strip()
    print(f"✓ Transcription successful: '{result_text}'")
    
    # Test 3: Send to server via HTTP
    print("\n=== Test 3: Sending to server via HTTP ===")
    try:
        req = Request('http://localhost:8765/transcribe', data=audio_bytes)
        req.add_header('Content-Type', 'application/octet-stream')
        req.add_header('Content-Length', str(len(audio_bytes)))
        
        with urlopen(req, timeout=30) as response:
            result = json.loads(response.read().decode())
            print(f"✓ Server response: {json.dumps(result, indent=2)}")
    except Exception as http_error:
        print(f"✗ HTTP error: {http_error}")
    
except Exception as e:
    print(f"✗ Error: {e}")
    import traceback
    traceback.print_exc()
finally:
    import os
    if os.path.exists(wav_path):
        os.unlink(wav_path)
        print(f"\nCleaned up test file: {wav_path}")

