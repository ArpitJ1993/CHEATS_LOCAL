import React, { useEffect, useRef, useState, useMemo, useCallback } from 'react';
import { useSelector } from 'react-redux';
import { RootState } from '../store';
import { Paper, Typography, Box } from '@mui/material';
import { LoadingIndicator } from '../core-components/LoadingIndicator';
import { createVendorProvider, getVendorMetadata } from '../vendors';

interface MeetingsSummaryProps {
  enabled: boolean;
  resetCounter?: number;
  onClear?: () => void;
}

export const MeetingsSummary: React.FC<MeetingsSummaryProps> = ({ enabled, resetCounter, onClear }) => {
  const { settings } = useSelector((state: RootState) => state.settings);
  const [summary, setSummary] = useState('Waiting for meeting to start...');
  const [isStreaming, setIsStreaming] = useState(false);
  const intervalRef = useRef<NodeJS.Timeout | null>(null);
  const inFlightAbortRef = useRef<() => void>();
  const vendorKey = settings.vendorKeys?.[settings.vendor] || '';
  const provider = useMemo(() => createVendorProvider(settings.vendor, vendorKey), [settings.vendor, vendorKey]);

  // Helper function to remove duplicate words/phrases
  const removeDuplicateWords = useCallback((text: string): string => {
    const words = text.split(/\s+/);
    const result: string[] = [];
    
    for (let i = 0; i < words.length; i++) {
      const word = words[i].toLowerCase().replace(/[.,!?;:]/g, '');
      // Check for duplicate consecutive words
      if (i === 0 || word !== words[i - 1].toLowerCase().replace(/[.,!?;:]/g, '')) {
        result.push(words[i]);
      }
    }
    
    return result.join(' ');
  }, []);

  const runSummary = useCallback(() => {
    // Get accumulated transcript from localTranscriptionService
    const service = (window as any).__localTranscriptionService;
    if (!service) {
      console.warn('Local transcription service not available');
      return;
    }

    const transcript = service.getFullTranscript();
    if (!transcript || transcript.trim().length < 20) {
      // Not enough content yet
      return;
    }

    let cancelled = false;
    inFlightAbortRef.current = () => { cancelled = true; };
    setIsStreaming(true);

    let buffer = '';

    const callbacks = {
      onChunk: (chunk: string) => {
        if (cancelled) return;
        buffer += chunk;
        // Remove duplicate words/phrases from summary
        const deduplicated = removeDuplicateWords(buffer);
        setSummary(deduplicated);
      },
      onComplete: () => {
        if (cancelled) return;
        setIsStreaming(false);
      },
      onError: () => {
        if (cancelled) return;
        setIsStreaming(false);
      }
    };

    const summaryMessages = [
      {
        role: 'system' as const,
        content: 'You are a real-time meeting summarizer. Produce concise summaries focused on key points, decisions, and action items. IMPORTANT: Do not repeat the same information. Ensure your summary has no duplicate words or phrases.'
      },
      {
        role: 'user' as const,
        content: `Full meeting transcript:\n\n${transcript}\n\nGenerate a concise summary with no duplicate information:`
      }
    ];

    const summaryPromise = provider.streamAudioSummary
      ? provider.streamAudioSummary({ transcript, callbacks })
      : provider.streamText(summaryMessages, callbacks);

    summaryPromise.catch(() => {
      if (cancelled) return;
      setIsStreaming(false);
    });
  }, [provider, removeDuplicateWords]);

  // Reset handler: clear transcript when resetCounter changes
  useEffect(() => {
    if (resetCounter === undefined) return;
    const service = (window as any).__localTranscriptionService;
    if (service) {
      service.resetTranscript();
    }
    setSummary('Waiting for meeting to start...');
  }, [resetCounter]);

  // Call summary every 5 seconds when enabled
  useEffect(() => {
    if (!enabled) {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
      return;
    }

    // Initial call
    runSummary();

    // Set up interval to call every 5 seconds
    intervalRef.current = setInterval(() => {
      runSummary();
    }, 5000);

    return () => {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
      if (inFlightAbortRef.current) {
        inFlightAbortRef.current();
      }
    };
  }, [enabled, runSummary]);

  return (
    <Paper elevation={2} sx={{ p: 2, height: 'calc(100vh - 160px)', overflow: 'auto', background: 'var(--color-surface)', border: '1px solid var(--color-border)' }}>
      <Typography variant="h6" gutterBottom sx={{ color: 'var(--color-text)', fontWeight: 600 }}>
        Summary
      </Typography>
      <Box sx={{ display: 'flex', gap: 1, mb: 1 }}>
        <button 
          type="button"
          onClick={() => setSummary('')}
          style={{ padding: '6px 12px', borderRadius: 6, border: '1px solid var(--color-border)', cursor: 'default', background: 'transparent', color: 'var(--color-text)' }}
        >
          Clear Summary
        </button>
      </Box>
      {isStreaming ? (
        <LoadingIndicator loading message="Summarizing…" size="small" />
      ) : (
        <Box component="div" sx={{ whiteSpace: 'pre-wrap', lineHeight: 1.5 }} data-summary-text>
          {summary}
        </Box>
      )}
    </Paper>
  );
};

export default MeetingsSummary;


