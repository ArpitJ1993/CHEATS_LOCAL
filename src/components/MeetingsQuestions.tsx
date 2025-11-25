import React, { useEffect, useMemo, useRef, useState, useCallback } from 'react';
import { useSelector } from 'react-redux';
import { RootState } from '../store';
import { Paper, Typography, Box, List, ListItem, ListItemText, Chip } from '@mui/material';
import { LoadingIndicator } from '../core-components/LoadingIndicator';
import { createVendorProvider } from '../vendors';

interface Question {
  id: string;
  text: string;
  source: 'microphone' | 'system';
  timestamp: string;
}

interface MeetingsQuestionsProps {
  enabled: boolean;
  onSelect?: (text: string) => void;
  resetCounter?: number;
}

export const MeetingsQuestions: React.FC<MeetingsQuestionsProps> = ({ enabled, onSelect, resetCounter }) => {
  const { settings } = useSelector((state: RootState) => state.settings);
  const micLabel = settings.userName?.trim() || 'Microphone';
  const sysLabel = settings.participantName?.trim() || 'System';
  const [questions, setQuestions] = useState<Question[]>([]);
  const [isProcessing, setIsProcessing] = useState(false);
  const intervalRef = useRef<NodeJS.Timeout | null>(null);
  const questionsMapRef = useRef<Map<string, Question>>(new Map());
  const vendorKey = settings.vendorKeys?.[settings.vendor] || '';
  const provider = useMemo(() => createVendorProvider(settings.vendor, vendorKey), [settings.vendor, vendorKey]);

  // Reset handler: when counter changes, clear questions state
  useEffect(() => {
    if (resetCounter === undefined) return;
    questionsMapRef.current.clear();
    setQuestions([]);
    const service = (window as any).__localTranscriptionService;
    if (service) {
      service.resetTranscript();
    }
  }, [resetCounter]);

  const validateQuestionsWithAI = useCallback(async () => {
    // Get accumulated transcript from localTranscriptionService
    const service = (window as any).__localTranscriptionService;
    if (!service) {
      console.warn('Local transcription service not available');
      return;
    }

    const transcript = service.getFullTranscript();
    if (!transcript || transcript.trim().length < 50) {
      // Not enough content yet
      return;
    }

    setIsProcessing(true);

    try {
      const messages = [
        {
          role: 'system' as const,
          content:
            'You are a question extraction specialist. Analyze the transcript and identify ALL questions. Be comprehensive - catch questions that end with "?", rhetorical questions, indirect questions, and clarification requests. IMPORTANT: Do not extract duplicate questions. Return ONLY valid JSON array: [{"q":"exact question text","s":"microphone" or "system"}]. No markdown, no explanation.'
        },
        {
          role: 'user' as const,
          content: `Full meeting transcript:\n${transcript}\n\nExtract all unique questions as JSON array:`
        }
      ];

      let response = '';
      await provider.streamText(
        messages,
        {
          onChunk: (chunk: string) => { response += chunk; },
          onComplete: () => {
            try {
              // Multiple JSON extraction attempts
              let extracted = null;

              // Try 1: Direct parse
              try {
                extracted = JSON.parse(response);
              } catch {
                // Try 2: Find JSON array in response
                const jsonMatch = response.match(/\[[\s\S]*?\]/);
                if (jsonMatch) {
                  extracted = JSON.parse(jsonMatch[0]);
                }
              }

              if (Array.isArray(extracted) && extracted.length > 0) {
                extracted.forEach((item: { q?: string; question?: string; s?: string; source?: string }) => {
                  const questionText = item.q || item.question;
                  const source = (item.s || item.source) === 'system' ? 'system' : 'microphone';

                  if (questionText && questionText.trim().length > 5) {
                    const questionId = `ai-${source}-${questionText.substring(0, 50)}`;

                    if (!questionsMapRef.current.has(questionId)) {
                      questionsMapRef.current.set(questionId, {
                        id: questionId,
                        text: questionText.trim(),
                        source,
                        timestamp: new Date().toLocaleTimeString()
                      });
                    }
                  }
                });

                setQuestions(Array.from(questionsMapRef.current.values()));
              }
            } catch (e) {
              console.warn('AI validation parse error', e);
            }
            setIsProcessing(false);
          },
          onError: () => setIsProcessing(false)
        }
      );
    } catch (err) {
      console.error('AI validation error', err);
      setIsProcessing(false);
    }
  }, [provider]);

  // Call questions extraction every 10 seconds when enabled
  useEffect(() => {
    if (!enabled) {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
      return;
    }

    // Initial call
    validateQuestionsWithAI();

    // Set up interval to call every 10 seconds
    intervalRef.current = setInterval(() => {
      validateQuestionsWithAI();
    }, 10000);

    return () => {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
    };
  }, [enabled, validateQuestionsWithAI]);

  return (
    <Paper elevation={2} sx={{ p: 2, height: 'calc(100vh - 160px)', overflow: 'auto', background: 'var(--color-surface)', border: '1px solid var(--color-border)' }}>
      <Typography variant="h6" gutterBottom sx={{ color: 'var(--color-text)', fontWeight: 600 }}>
        Questions
      </Typography>
      {isProcessing ? (
        <LoadingIndicator loading message="Extracting questions…" size="small" />
      ) : questions.length === 0 ? (
        <Box sx={{ textAlign: 'center', py: 4, color: 'text.secondary' }}>
          No questions detected yet. Start streaming to capture questions.
        </Box>
      ) : (
        <List data-questions-list sx={{ 
          '& .MuiListItem-root:hover': { background: 'rgba(100, 149, 237, 0.08)' }
        }}>
          {questions.map((q) => (
            <ListItem 
              key={q.id} 
              sx={{ borderBottom: '1px solid', borderColor: 'divider', cursor: onSelect ? 'pointer' : 'default' }}
              onClick={() => onSelect?.(q.text)}
            >
              <ListItemText
                primary={q.text}
                secondary={
                  <Box sx={{ display: 'flex', gap: 1, alignItems: 'center', mt: 0.5 }}>
                    <Chip 
                      label={q.source === 'microphone' ? `🎤 ${micLabel}` : `🔊 ${sysLabel}`} 
                      size="small" 
                      variant="outlined"
                    />
                    <Typography variant="caption" color="text.secondary">
                      {q.timestamp}
                    </Typography>
                  </Box>
                }
              />
            </ListItem>
          ))}
        </List>
      )}
    </Paper>
  );
};

export default MeetingsQuestions;

