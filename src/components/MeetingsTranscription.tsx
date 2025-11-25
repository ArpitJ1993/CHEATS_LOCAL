import React, { useEffect, useRef, useState } from 'react';
import { Paper, Typography, Box } from '@mui/material';
import styled from '@emotion/styled';

const TranscriptionContainer = styled(Paper)`
  padding: 16px;
  margin-top: 12px;
  background: var(--color-surface);
  border: 1px solid var(--color-border);
  height: 400px;
  display: flex;
  flex-direction: column;
`;

const TranscriptionTitle = styled(Typography)`
  color: var(--color-text);
  margin-bottom: 12px;
  font-weight: 600;
`;

const TranscriptionContent = styled.div`
  flex: 1;
  overflow-y: auto;
  padding: 8px;
  background: var(--color-background);
  border: 1px solid var(--color-border);
  border-radius: 4px;
  font-family: monospace;
  font-size: 0.9em;
  color: var(--color-text);
  white-space: pre-wrap;
  word-wrap: break-word;
`;

const TranscriptionLine = styled.div<{ source: 'microphone' | 'system' }>`
  margin-bottom: 8px;
  padding: 4px 0;
  border-bottom: 1px solid rgba(255, 255, 255, 0.05);
`;

const TranscriptionPrefix = styled.span<{ source: 'microphone' | 'system' }>`
  font-weight: 600;
  color: ${props => props.source === 'microphone' ? '#6aa0ff' : '#9a6bff'};
  margin-right: 8px;
`;

interface TranscriptionEntry {
  id: string;
  source: 'microphone' | 'system';
  text: string;
  timestamp: number;
}

interface MeetingsTranscriptionProps {
  enabled: boolean;
}

export const MeetingsTranscription: React.FC<MeetingsTranscriptionProps> = ({ enabled }) => {
  const [transcriptions, setTranscriptions] = useState<TranscriptionEntry[]>([]);
  const contentRef = useRef<HTMLDivElement>(null);
  const lastTranscriptionRef = useRef<{ text: string; timestamp: number } | null>(null);

  useEffect(() => {
    if (!enabled) {
      setTranscriptions([]);
      lastTranscriptionRef.current = null;
      return;
    }

    console.log('MeetingsTranscription: Setting up event listener for local-transcription');

    const handleTranscription = (event: Event) => {
      const customEvent = event as CustomEvent<{ source: 'microphone' | 'system'; text: string }>;
      console.log('MeetingsTranscription: Received transcription event:', customEvent.detail);
      const { source, text } = customEvent.detail;
      if (!text || text.trim() === '') {
        console.log('MeetingsTranscription: Empty text, ignoring');
        return;
      }

      const trimmedText = text.trim();
      const now = Date.now();

      // Deduplication: Skip if same text as last transcription within 2 seconds
      if (lastTranscriptionRef.current) {
        const timeSinceLast = now - lastTranscriptionRef.current.timestamp;
        if (trimmedText === lastTranscriptionRef.current.text && timeSinceLast < 2000) {
          console.log('MeetingsTranscription: Skipping duplicate transcription');
          return;
        }
      }

      // Also check against existing transcriptions to prevent duplicates
      setTranscriptions(prev => {
        // Check if this exact text was added recently (within last 3 seconds)
        const recentEntry = prev.find(entry => 
          entry.text === trimmedText && 
          entry.source === source &&
          (now - entry.timestamp) < 3000
        );
        
        if (recentEntry) {
          console.log('MeetingsTranscription: Skipping duplicate - already in list');
          return prev;
        }

        const entry: TranscriptionEntry = {
          id: `${source}-${now}-${Math.random()}`,
          source,
          text: trimmedText,
          timestamp: now
        };

        console.log('MeetingsTranscription: Adding transcription entry:', entry);
        lastTranscriptionRef.current = { text: trimmedText, timestamp: now };
        return [...prev, entry];
      });
    };

    window.addEventListener('local-transcription', handleTranscription);
    console.log('MeetingsTranscription: Event listener added');

    return () => {
      console.log('MeetingsTranscription: Removing event listener');
      window.removeEventListener('local-transcription', handleTranscription);
    };
  }, [enabled]);

  useEffect(() => {
    // Auto-scroll to bottom when new transcriptions arrive
    if (contentRef.current) {
      contentRef.current.scrollTop = contentRef.current.scrollHeight;
    }
  }, [transcriptions]);

  if (!enabled) {
    return null;
  }

  return (
    <TranscriptionContainer elevation={2}>
      <TranscriptionTitle variant="h6">Transcription</TranscriptionTitle>
      <TranscriptionContent ref={contentRef}>
        {transcriptions.length === 0 ? (
          <div style={{ color: 'var(--color-text-secondary)', fontStyle: 'italic' }}>
            Waiting for audio input...
          </div>
        ) : (
          transcriptions.map((entry) => (
            <TranscriptionLine key={entry.id} source={entry.source}>
              <TranscriptionPrefix source={entry.source}>
                {entry.source === 'microphone' ? 'Microphone:' : 'System:'}
              </TranscriptionPrefix>
              {entry.text}
            </TranscriptionLine>
          ))
        )}
      </TranscriptionContent>
    </TranscriptionContainer>
  );
};

export default MeetingsTranscription;

