import { useCallback, useEffect, useRef, useState } from "react";
import i18n from "../../../i18n";

// Dictation into a text box with the browser's own speech recognition
// (docs/photo-review-plan.md, phase 4). Chrome on Android and Safari on iPad
// both have it; where it is missing the button is simply not offered. Only the
// words come back — nothing is stored but what lands in the box, and nothing
// leaves the device except through the browser's own service.

type Recognition = {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  onresult: ((event: { resultIndex: number; results: ArrayLike<ArrayLike<{ transcript: string }> & { isFinal: boolean }> }) => void) | null;
  onend: (() => void) | null;
  onerror: (() => void) | null;
  start: () => void;
  stop: () => void;
};

type RecognitionCtor = new () => Recognition;

function recognitionCtor(): RecognitionCtor | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as { SpeechRecognition?: RecognitionCtor; webkitSpeechRecognition?: RecognitionCtor };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

/** The language the recogniser listens for: the app's own. */
function dictationLanguage(): string {
  return i18n.language?.toLowerCase().startsWith("ru") ? "ru-RU" : "en-US";
}

export function useDictation(onText: (finalText: string) => void): { supported: boolean; listening: boolean; toggle: () => void } {
  const [listening, setListening] = useState(false);
  const ref = useRef<Recognition | null>(null);
  const supported = recognitionCtor() !== null;

  useEffect(() => () => { ref.current?.stop(); }, []);

  const toggle = useCallback(() => {
    if (listening) { ref.current?.stop(); return; }
    const Ctor = recognitionCtor();
    if (!Ctor) return;
    const recognition = new Ctor();
    recognition.lang = dictationLanguage();
    recognition.continuous = true;
    recognition.interimResults = false;
    recognition.onresult = (event) => {
      for (let i = event.resultIndex; i < event.results.length; i += 1) {
        const result = event.results[i];
        if (result.isFinal) onText(result[0].transcript.trim());
      }
    };
    recognition.onend = () => { setListening(false); ref.current = null; };
    recognition.onerror = () => { setListening(false); ref.current = null; };
    ref.current = recognition;
    try {
      recognition.start();
      setListening(true);
    } catch {
      ref.current = null;
    }
  }, [listening, onText]);

  return { supported, listening, toggle };
}
