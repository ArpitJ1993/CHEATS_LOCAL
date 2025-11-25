#!/usr/bin/env python3
"""
Whisper Streaming Server for Real-time Transcription
Uses faster-whisper with optimized streaming approach
Supports WebSocket streaming for low-latency, continuous transcription
"""

import os
import sys
import json
import asyncio
import logging
import threading
import tempfile
import time
import wave
import subprocess
import numpy as np
from collections import deque
from concurrent.futures import ThreadPoolExecutor
from http.server import HTTPServer, BaseHTTPRequestHandler
from urllib.parse import urlparse

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s'
)
logger = logging.getLogger(__name__)

# Try to import faster-whisper
try:
    from faster_whisper import WhisperModel
    USE_FASTER_WHISPER = True
    logger.info("Using faster-whisper for transcription")
except ImportError:
    USE_FASTER_WHISPER = False
    logger.error("faster-whisper not available!")
    logger.error("Please install: pip install faster-whisper")
    sys.exit(1)
# Try to import websockets
try:
    import websockets
    from websockets.server import serve as websockets_serve
    from websockets.exceptions import ConnectionClosed
    WEBSOCKETS_AVAILABLE = True
    logger.info("WebSocket support available")
except ImportError:
    WEBSOCKETS_AVAILABLE = False
    logger.error("websockets library not available. Install with: pip install websockets")
    sys.exit(1)

# Model configuration
MODEL_NAME = "small.en"
MODEL_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "whisper_models")
DEVICE = "cpu"  # Use "cuda" if you have GPU support
COMPUTE_TYPE = "int8"  # Use "float16" for better quality but slower
SAMPLE_RATE = 16000

# Initialize model
model = None

# Thread pool for parallel transcription processing
import multiprocessing
MAX_WORKERS = min(4, max(2, multiprocessing.cpu_count() // 2))
transcription_executor = ThreadPoolExecutor(max_workers=MAX_WORKERS, thread_name_prefix="transcription")
logger.info(f"Initialized transcription thread pool with {MAX_WORKERS} workers")

# Audio buffers for streaming (per source, per connection)
audio_buffers = {}
# Minimum chunk size for processing (1.5 seconds = 48000 bytes at 16kHz mono Int16)
# Whisper needs at least 1-2 seconds of audio for proper transcription
MIN_CHUNK_SIZE = 48000  # 1.5 seconds of audio (16kHz * 1.5 * 2 bytes)
# Overlap between chunks to prevent word boundary issues (500ms)
OVERLAP_SIZE = 16000  # 500ms of audio
# Maximum buffer size to prevent memory issues (5 seconds)
MAX_BUFFER_SIZE = 160000  # 5 seconds

def load_model():
    """Load the Whisper model"""
    global model
    if model is not None:
        return model
    
    try:
        logger.info(f"Loading Whisper model: {MODEL_NAME}")
        logger.info(f"Model directory: {MODEL_DIR}")
        logger.info(f"Device: {DEVICE}, Compute type: {COMPUTE_TYPE}")
        
        model = WhisperModel(
            MODEL_NAME,
            device=DEVICE,
            compute_type=COMPUTE_TYPE,
            download_root=MODEL_DIR
        )
        logger.info("Model loaded successfully")
        return model
    except Exception as e:
        logger.error(f"Failed to load model: {e}")
        raise

def pcm_bytes_to_wav(pcm_bytes, sample_rate=SAMPLE_RATE):
    """Convert PCM Int16 bytes to WAV file"""
    wav_path = None
    try:
        # Validate input - need at least 2000 bytes (125ms at 16kHz)
        min_bytes = 2000
        if len(pcm_bytes) < min_bytes:
            raise ValueError(f"Audio data too small: {len(pcm_bytes)} bytes (minimum: {min_bytes})")
        
        # Ensure length is even (Int16 = 2 bytes per sample)
        if len(pcm_bytes) % 2 != 0:
            logger.warning(f"PCM data length is odd ({len(pcm_bytes)}), truncating last byte")
            pcm_bytes = pcm_bytes[:-1]
        
        # Create temporary WAV file
        wav_path = tempfile.NamedTemporaryFile(delete=False, suffix='.wav', prefix='whisper_stream_').name
            
        # Verify PCM data is valid Int16
        try:
            pcm_array = np.frombuffer(pcm_bytes, dtype=np.int16)
        except Exception as e:
            logger.error(f"Failed to parse PCM data as Int16: {e}")
            raise ValueError(f"Invalid PCM data format: {e}")
        
        num_samples = len(pcm_array)
        
        if num_samples == 0:
            raise ValueError("No audio samples in PCM data")
        
        # Check for audio energy (simple silence detection)
        max_amplitude = np.max(np.abs(pcm_array))
        if max_amplitude < 100:  # Very quiet, likely silence
            logger.debug(f"Audio appears to be silence (max amplitude: {max_amplitude})")
            # Still create WAV file, let Whisper's VAD handle it
        
        # Write WAV file (always, regardless of silence check)
        try:
            with wave.open(wav_path, 'wb') as wav_file:
                wav_file.setnchannels(1)  # Mono
                wav_file.setsampwidth(2)  # 16-bit (2 bytes)
                wav_file.setframerate(sample_rate)
                wav_file.writeframes(pcm_bytes)
                # Ensure data is flushed to disk
                wav_file.close()
            
            # Small delay to ensure file is fully written to disk
            time.sleep(0.01)
            
            # Verify WAV file was created and has content
            if not os.path.exists(wav_path):
                raise ValueError(f"WAV file was not created: {wav_path}")
            
            file_size = os.path.getsize(wav_path)
            if file_size == 0:
                raise ValueError(f"WAV file is empty: {wav_path}")
            
            # Verify WAV file can be read back (validates format)
            try:
                with wave.open(wav_path, 'rb') as test_wav:
                    test_frames = test_wav.getnframes()
                    test_rate = test_wav.getframerate()
                    test_channels = test_wav.getnchannels()
                    test_width = test_wav.getsampwidth()
                    if test_frames != num_samples:
                        logger.warning(f"WAV file frame count mismatch: expected {num_samples}, got {test_frames}")
                    if test_rate != sample_rate:
                        raise ValueError(f"WAV file sample rate mismatch: expected {sample_rate}, got {test_rate}")
                    if test_channels != 1:
                        raise ValueError(f"WAV file channel count mismatch: expected 1, got {test_channels}")
                    if test_width != 2:
                        raise ValueError(f"WAV file sample width mismatch: expected 2, got {test_width}")
            except Exception as wav_read_error:
                logger.error(f"WAV file validation failed: {wav_read_error}")
                raise ValueError(f"Invalid WAV file format: {wav_read_error}")
            
            logger.debug(f"Created WAV file: {wav_path}, {num_samples} samples, {num_samples/sample_rate:.2f}s, max_amp: {max_amplitude}, file_size: {file_size} bytes")
        except Exception as e:
            logger.error(f"Failed to write WAV file {wav_path}: {e}")
            raise
        
        return wav_path
    except Exception as e:
        # Clean up on error
        if wav_path and os.path.exists(wav_path):
            try:
                os.unlink(wav_path)
            except:
                pass
        raise

def convert_webm_to_wav(webm_data, sample_rate=SAMPLE_RATE):
    """Convert WebM audio data to WAV file using ffmpeg"""
    tmp_path = None
    wav_path = None
    try:
        # Create temporary WebM file
        tmp_path = tempfile.NamedTemporaryFile(delete=False, suffix='.webm', prefix='whisper_webm_').name
        with open(tmp_path, 'wb') as f:
            f.write(webm_data)
        
        # Convert to WAV using ffmpeg
        wav_path = tmp_path.rsplit('.', 1)[0] + '.wav'
        cmd = [
            'ffmpeg',
            '-y',  # Overwrite output
            '-i', tmp_path,
            '-vn',  # No video
            '-f', 'wav',
            '-acodec', 'pcm_s16le',
            '-ar', str(sample_rate),
            '-ac', '1',  # Mono
            '-loglevel', 'error',
            '-nostdin',
            wav_path
        ]
        
        result = subprocess.run(
            cmd,
            check=False,
            capture_output=True,
            timeout=30,
            text=True
        )
        
        if result.returncode != 0:
            raise Exception(f"FFmpeg conversion failed: {result.stderr[:200]}")
        
        if not os.path.exists(wav_path) or os.path.getsize(wav_path) == 0:
            raise Exception("FFmpeg conversion failed: empty output file")
        
        return wav_path
    except Exception as e:
        # Clean up on error
        if tmp_path and os.path.exists(tmp_path):
            try:
                os.unlink(tmp_path)
            except:
                pass
        if wav_path and os.path.exists(wav_path):
            try:
                os.unlink(wav_path)
            except:
                pass
        raise
    finally:
        # Clean up WebM file
        if tmp_path and os.path.exists(tmp_path):
            try:
                os.unlink(tmp_path)
            except:
                pass

def transcribe_audio_chunk(audio_data, is_webm=False):
    """Transcribe audio chunk using faster-whisper"""
    wav_path = None
    try:
        # Convert to WAV (PCM or WebM)
        if is_webm:
            wav_path = convert_webm_to_wav(audio_data)
        else:
            wav_path = pcm_bytes_to_wav(audio_data)
        
        # Load model if needed
        if model is None:
            load_model()
        
        # Verify WAV file exists and is readable before transcribing
        if not os.path.exists(wav_path):
            raise ValueError(f"WAV file does not exist: {wav_path}")
        
        file_size = os.path.getsize(wav_path)
        if file_size < 44:  # WAV header is at least 44 bytes
            raise ValueError(f"WAV file too small (likely corrupted): {wav_path}, size: {file_size} bytes")
        
        logger.debug(f"Transcribing WAV file: {wav_path}, size: {file_size} bytes")
        
        # Transcribe with optimized settings for accuracy and latency balance
        try:
            segments, info = model.transcribe(
                wav_path,
                language="en",
                beam_size=3,  # Balanced: good accuracy with reasonable speed
                vad_filter=True,
                condition_on_previous_text=False,  # Don't condition on previous text for independence
                initial_prompt=None,
                word_timestamps=False,
                temperature=0.0,
                best_of=1  # Faster processing
            )
        except Exception as transcribe_error:
            logger.error(f"faster-whisper transcribe error: {transcribe_error}", exc_info=True)
            # Try to get more details about the error
            error_msg = str(transcribe_error)
            if "Invalid data" in error_msg or "Errno" in error_msg:
                # Check if WAV file is valid by trying to read it
                try:
                    with wave.open(wav_path, 'rb') as test_wav:
                        test_frames = test_wav.getnframes()
                        test_rate = test_wav.getframerate()
                        logger.error(f"WAV file appears valid: {test_frames} frames, {test_rate} Hz sample rate")
                except Exception as wav_error:
                    logger.error(f"WAV file is corrupted or invalid: {wav_error}")
                    raise ValueError(f"Invalid WAV file format: {wav_error}")
            raise
            
        # Collect text from segments
        text_parts = []
        segment_count = 0
        for segment in segments:
            segment_count += 1
            segment_text = segment.text.strip()
            if segment_text and len(segment_text) >= 2:
                # Filter out common hallucinations
                segment_lower = segment_text.lower()
                hallucination_patterns = [
                    'thank you', 'thanks', 'subscribe', 'please subscribe',
                    'like and subscribe', 'thank you for watching',
                    'thanks for watching', 'please like and subscribe'
                ]
                # Check if segment has no speech (hallucination indicator)
                if hasattr(segment, 'no_speech_prob') and segment.no_speech_prob > 0.5:
                    logger.debug(f"Skipping segment with high no_speech_prob ({segment.no_speech_prob:.2f}): {segment_text}")
                    continue
                
                if not any(pattern in segment_lower for pattern in hallucination_patterns):
                    text_parts.append(segment_text)
        
        full_text = " ".join(text_parts).strip()
        
        # Log transcription result for debugging
        if full_text:
            logger.info(f"Transcription result ({segment_count} segments): {full_text[:100]}...")
        else:
            logger.debug(f"No transcription text extracted from {segment_count} segments (likely silence - this is normal)")
            return None
        
        if full_text:
            return {
                "text": full_text,
                "language": info.language if hasattr(info, 'language') else "en"
            }
        else:
            return None
    except Exception as e:
        logger.error(f"Transcription error: {e}")
        raise
    finally:
        # Clean up WAV file
        if wav_path and os.path.exists(wav_path):
            try:
                os.unlink(wav_path)
            except:
                pass

def transcribe_audio_request(audio_data, is_webm=False):
    """Transcribe audio from HTTP request (returns dict with success/error)"""
    try:
        # Validate minimum audio size
        min_size = 2000 if not is_webm else 1000  # At least 125ms of PCM or small WebM
        if len(audio_data) < min_size:
            logger.debug(f"Audio data too small: {len(audio_data)} bytes")
            return {
                "success": True,
                "text": "",  # Empty text for silence/too small
                "language": "en"
            }
        
        result = transcribe_audio_chunk(audio_data, is_webm)
        
        # Handle None result (silence or no transcription)
        if result is None:
            return {
                "success": True,
                "text": "",  # Empty text for silence
                "language": "en"
            }
        
        text = result.get("text", "").strip()
        
        # Return success even if text is empty (silence is not an error)
        return {
            "success": True,
            "text": text,
            "language": result.get("language", "en")
        }
    except Exception as e:
        logger.error(f"Transcription request failed: {e}", exc_info=True)
        return {
            "success": False,
            "error": str(e),
            "text": ""
        }

async def process_audio_chunk(websocket, source_type, audio_chunk):
    """Process an audio chunk asynchronously"""
    try:
        # Process transcription in thread pool
        result = await asyncio.get_event_loop().run_in_executor(
            transcription_executor,
            transcribe_audio_chunk,
            audio_chunk,
            False  # is_webm = False for PCM
        )
        
        # Send transcription if available
        text = result.get("text", "").strip() if result.get("text") else ""
        
        if text:
            try:
                await websocket.send(json.dumps({
                    "type": "transcription",
                    "source": source_type,
                    "text": text,
                    "language": result.get("language", "en")
                }))
                logger.debug(f"Sent transcription for {source_type}: {text[:50]}...")
            except Exception as send_error:
                logger.error(f"Failed to send transcription: {send_error}")
        else:
            # Send silence indicator
            try:
                await websocket.send(json.dumps({
                    "type": "silence",
                    "source": source_type
                }))
            except:
                pass
            
    except Exception as e:
        logger.error(f"Error processing audio chunk for {source_type}: {e}", exc_info=True)
        try:
            error_message = str(e) if e else "Unknown error occurred"
            await websocket.send(json.dumps({
                "type": "error",
                "source": source_type,
                "message": error_message
            }))
        except Exception as send_error:
            logger.error(f"Failed to send error message: {send_error}")

async def handle_websocket(websocket, path):
    """Handle WebSocket connections for streaming transcription"""
    client_address = websocket.remote_address
    logger.info(f"WebSocket connection opened from {client_address}")
    
    try:
        # Send welcome message
        await websocket.send(json.dumps({
            "type": "connected",
            "message": "WebSocket connection established",
            "model": MODEL_NAME,
            "streaming": True
        }))
        
        source_type = None
        buffer_key = None
        
        async for message in websocket:
            try:
                # Handle text messages (control messages)
                if isinstance(message, str):
                    data = json.loads(message)
                    msg_type = data.get("type")
                    
                    if msg_type == "start":
                        source_type = data.get("source", "microphone")
                        buffer_key = f"{client_address}_{source_type}"
                        
                        # Initialize buffer for this connection
                        audio_buffers[buffer_key] = bytearray()
                        
                        logger.info(f"Starting transcription stream for {source_type}")
                        await websocket.send(json.dumps({
                            "type": "started",
                            "source": source_type
                        }))
                    elif msg_type == "stop":
                        logger.info(f"Stopping transcription stream")
                        
                        # Clean up buffer
                        if buffer_key and buffer_key in audio_buffers:
                            del audio_buffers[buffer_key]
                        
                        await websocket.send(json.dumps({
                            "type": "stopped"
                        }))
                    elif msg_type == "ping":
                        await websocket.send(json.dumps({
                            "type": "pong"
                        }))
                    continue
                
                # Handle binary messages (audio data - PCM)
                if isinstance(message, bytes):
                    if not source_type:
                        source_type = "microphone"
                        buffer_key = f"{client_address}_{source_type}"
                        if buffer_key not in audio_buffers:
                            audio_buffers[buffer_key] = bytearray()
                    
                    # Accumulate PCM data in buffer
                    if buffer_key:
                        audio_buffers[buffer_key].extend(message)
                        
                        # Prevent buffer from growing too large
                        if len(audio_buffers[buffer_key]) > MAX_BUFFER_SIZE:
                            # Keep only the most recent data
                            excess = len(audio_buffers[buffer_key]) - MAX_BUFFER_SIZE
                            audio_buffers[buffer_key] = audio_buffers[buffer_key][excess:]
                            logger.warning(f"Buffer overflow for {source_type}, trimmed {excess} bytes")
                        
                        # Process when we have enough data (1.5 second chunks with overlap)
                        while len(audio_buffers[buffer_key]) >= MIN_CHUNK_SIZE:
                            # Extract chunk to process
                            chunk = bytes(audio_buffers[buffer_key][:MIN_CHUNK_SIZE])
                            # Keep overlap + remaining data in buffer for next chunk
                            # This prevents word boundary issues
                            keep_size = OVERLAP_SIZE
                            if len(audio_buffers[buffer_key]) > MIN_CHUNK_SIZE:
                                # Keep overlap from current chunk + any remaining data
                                audio_buffers[buffer_key] = audio_buffers[buffer_key][MIN_CHUNK_SIZE - OVERLAP_SIZE:]
                            else:
                                # No more data, clear buffer
                                audio_buffers[buffer_key] = bytearray()
                            
                            # Process audio chunk asynchronously
                            asyncio.create_task(process_audio_chunk(websocket, source_type, chunk))
                
            except json.JSONDecodeError:
                # If it's not JSON, treat as binary audio data (PCM)
                if isinstance(message, bytes):
                    if not source_type:
                        source_type = "microphone"
                        buffer_key = f"{client_address}_{source_type}"
                        if buffer_key not in audio_buffers:
                            audio_buffers[buffer_key] = bytearray()
                    
                    if buffer_key:
                        audio_buffers[buffer_key].extend(message)
                        
                        if len(audio_buffers[buffer_key]) > MAX_BUFFER_SIZE:
                            excess = len(audio_buffers[buffer_key]) - MAX_BUFFER_SIZE
                            audio_buffers[buffer_key] = audio_buffers[buffer_key][excess:]
                        
                        while len(audio_buffers[buffer_key]) >= MIN_CHUNK_SIZE:
                            # Extract chunk to process
                            chunk = bytes(audio_buffers[buffer_key][:MIN_CHUNK_SIZE])
                            # Keep overlap + remaining data in buffer for next chunk
                            if len(audio_buffers[buffer_key]) > MIN_CHUNK_SIZE:
                                audio_buffers[buffer_key] = audio_buffers[buffer_key][MIN_CHUNK_SIZE - OVERLAP_SIZE:]
                            else:
                                audio_buffers[buffer_key] = bytearray()
                            
                            # Process audio chunk asynchronously
                            asyncio.create_task(process_audio_chunk(websocket, source_type, chunk))
            except Exception as e:
                logger.error(f"Error processing WebSocket message: {e}")
                try:
                    await websocket.send(json.dumps({
                        "type": "error",
                        "message": str(e)
                    }))
                except:
                    pass
    
    except ConnectionClosed:
        logger.info(f"WebSocket connection closed from {client_address}")
    except Exception as e:
        logger.error(f"WebSocket error: {e}", exc_info=True)
    finally:
        # Clean up buffers on disconnect
        if buffer_key and buffer_key in audio_buffers:
            del audio_buffers[buffer_key]

# HTTP server for health checks and transcription
class WhisperHTTPHandler(BaseHTTPRequestHandler):
    """HTTP request handler for health checks and transcription"""
    
    def do_GET(self):
        """Handle GET requests (health check)"""
        parsed_path = urlparse(self.path)
        if parsed_path.path == '/health':
                self.send_response(200)
                self.send_header('Content-Type', 'application/json')
                self.send_header('Access-Control-Allow-Origin', '*')
                self.end_headers()
                response = {
                    "status": "ok",
                    "model": MODEL_NAME,
                "streaming": True,
                "websocket": WEBSOCKETS_AVAILABLE,
                "faster_whisper": USE_FASTER_WHISPER
                }
                self.wfile.write(json.dumps(response).encode())
        else:
            self.send_error(404, "Not Found")
    
    def do_POST(self):
        """Handle POST requests (transcription)"""
        parsed_path = urlparse(self.path)
        if parsed_path.path == '/transcribe':
            self.handle_transcribe()
        else:
            self.send_error(404, "Not Found")
    
    def handle_transcribe(self):
        """Handle transcription request"""
        try:
            # Get content type
            content_type = self.headers.get('Content-Type', '')
            content_length = int(self.headers.get('Content-Length', 0))
            
            if content_length == 0:
                self.send_error(400, "No audio data provided")
                return
            
            # Read audio data
            audio_data = self.rfile.read(content_length)
            
            # Determine if it's WebM or PCM
            # Check for WebM EBML header first
            is_webm = False
            if len(audio_data) >= 4:
                # WebM/EBML header: 0x1A 0x45 0xDF 0xA3
                if audio_data[:4] == b'\x1a\x45\xdf\xa3':
                    is_webm = True
                elif 'webm' in content_type.lower():
                    is_webm = True
                # Otherwise assume PCM (application/octet-stream or audio/pcm)
            
            # Process transcription in thread pool
            future = transcription_executor.submit(
                transcribe_audio_request,
                audio_data,
                is_webm
            )
            
            # Wait for result (with timeout)
            try:
                result = future.result(timeout=30)
                
                # Send response
                self.send_response(200)
                self.send_header('Content-Type', 'application/json')
                self.send_header('Access-Control-Allow-Origin', '*')
                self.end_headers()
                self.wfile.write(json.dumps(result).encode())
            except Exception as e:
                logger.error(f"Transcription failed: {e}")
                self.send_response(500)
                self.send_header('Content-Type', 'application/json')
                self.send_header('Access-Control-Allow-Origin', '*')
                self.end_headers()
                error_response = {
                    "success": False,
                    "error": str(e),
                    "text": ""
                }
                self.wfile.write(json.dumps(error_response).encode())
                
        except Exception as e:
            logger.error(f"Error handling transcription request: {e}", exc_info=True)
            self.send_error(500, f"Internal server error: {str(e)}")
    
    def log_message(self, format, *args):
        logger.info(f"{self.address_string()} - {format % args}")

def run_http_server(port=8765):
    """Run HTTP server for health checks and transcription"""
    server_address = ('localhost', port)
    httpd = HTTPServer(server_address, WhisperHTTPHandler)
    logger.info(f"Whisper HTTP server running on http://localhost:{port}")
    logger.info(f"Endpoints: /health (GET), /transcribe (POST)")
    
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        logger.info("HTTP server shutting down...")
        httpd.shutdown()

async def run_combined_server(port=8765):
    """Run HTTP server (primary) and optional WebSocket server"""
    if not USE_FASTER_WHISPER:
        logger.error("faster-whisper is not available. Cannot start server.")
        sys.exit(1)
    
    # Load model on startup
    try:
        logger.info("Initializing Whisper model...")
        load_model()
        logger.info("Model initialized successfully")
    except Exception as e:
        logger.error(f"Failed to initialize model: {e}")
        sys.exit(1)
    
    # Start HTTP server in main thread (blocking) - this is the primary interface
    # HTTP server handles /health and /transcribe endpoints (same as landing page)
    logger.info(f"Starting Whisper HTTP server on http://localhost:{port}")
    logger.info(f"Endpoints: /health (GET), /transcribe (POST)")
    logger.info(f"Model: {MODEL_NAME}, Device: {DEVICE}, Compute type: {COMPUTE_TYPE}")
    logger.info("Using HTTP POST for reliable transcription (same as landing page)")
    
    # Run HTTP server (blocking)
    run_http_server(port)

def shutdown_handler(signum=None, frame=None):
    """Cleanup on shutdown"""
    logger.info("Shutting down transcription thread pool...")
    transcription_executor.shutdown(wait=True, timeout=10)
    audio_buffers.clear()
    logger.info("Shutdown complete")

if __name__ == '__main__':
    import signal
    
    # Register shutdown handler
    signal.signal(signal.SIGINT, shutdown_handler)
    signal.signal(signal.SIGTERM, shutdown_handler)
    
    port = int(os.environ.get('WHISPER_PORT', 8765))
    
    try:
        # Run HTTP server directly (blocking)
        if not USE_FASTER_WHISPER:
            logger.error("faster-whisper is not available. Cannot start server.")
            sys.exit(1)
        
        # Load model on startup
        try:
            logger.info("Initializing Whisper model...")
            load_model()
            logger.info("Model initialized successfully")
        except Exception as e:
            logger.error(f"Failed to initialize model: {e}")
            sys.exit(1)
        
        logger.info(f"Starting Whisper HTTP server on http://localhost:{port}")
        logger.info(f"Endpoints: /health (GET), /transcribe (POST)")
        logger.info(f"Model: {MODEL_NAME}, Device: {DEVICE}, Compute type: {COMPUTE_TYPE}")
        logger.info("Using HTTP POST for reliable transcription (same as landing page)")
        
        run_http_server(port)
    except KeyboardInterrupt:
        logger.info("Server shutting down...")
        shutdown_handler()
