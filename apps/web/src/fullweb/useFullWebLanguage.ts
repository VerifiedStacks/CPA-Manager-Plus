import { useTranslation } from 'react-i18next';
import { fullWebI18n } from '../i18n/fullweb';

/**
 * Subscribe to the Fresh shell's language. Text produced by `fullWebText` is not
 * reactive on its own, so a component that keeps a translation key in state has
 * to read this to re-render when the language changes.
 */
export function useFullWebLanguage(): string {
  const { i18n } = useTranslation(undefined, { i18n: fullWebI18n, useSuspense: false });
  return i18n.resolvedLanguage || i18n.language;
}
