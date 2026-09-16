import { Fyo } from 'fyo';
import { DEFAULT_LANGUAGE } from 'fyo/utils/consts';
import { setLanguageMapOnTranslationString } from 'fyo/utils/translation';
import { getShellDemux } from 'fyo/demux/shell';
import { systemLanguageRef } from './refs';

// Language: Language Code in books/translations
export const languageCodeMap: Record<string, string> = {
  Arabic: 'ar',
  Catalan: 'ca-ES',
  Danish: 'da',
  Dutch: 'nl',
  English: 'en',
  French: 'fr',
  German: 'de',
  Gujarati: 'gu',
  Hindi: 'hi',
  Indonesian: 'id',
  Korean: 'ko',
  Nepali: 'np',
  Persian: 'fa',
  Portuguese: 'pt',
  'Simplified Chinese': 'zh-CN',
  'Traditional Chinese': 'zh-Hant',
  Spanish: 'es',
  Swedish: 'sv',
  Albanian: 'sq',
  Turkish: 'tr',
};

/**
 * `fyo` is a parameter, not a module-top import of the desktop singleton:
 * that import was the blocker rendererWeb.ts's docblock named (it crashed
 * the web bundle on import), and the models-style rule is to pass fyo in.
 * Reloading is routed through the shell demux, so the Electron `ipc`
 * global is only ever touched on Desktop.
 */
export async function setLanguageMap(
  fyo: Fyo,
  initLanguage?: string,
  dontReload = false
) {
  const oldLanguage = fyo.config.get('language') as string;
  initLanguage ??= oldLanguage;
  const { code, language, usingDefault } = getLanguageCode(
    initLanguage,
    oldLanguage
  );

  let success = true;
  if (code === 'en') {
    setLanguageMapOnTranslationString(undefined);
  } else {
    success = await fetchAndSetLanguageMap(fyo, code);
  }

  if (success && !usingDefault) {
    fyo.config.set('language', language);
    systemLanguageRef.value = language;
  }

  if (!dontReload && success && initLanguage !== oldLanguage) {
    getShellDemux(fyo.isElectron).reloadWindow();
  }
  return success;
}

function getLanguageCode(initLanguage: string, oldLanguage: string) {
  let language = initLanguage ?? oldLanguage;
  let usingDefault = false;

  if (!language) {
    language = DEFAULT_LANGUAGE;
    usingDefault = true;
  }
  const code = languageCodeMap[language] ?? 'en';
  return { code, language, usingDefault };
}

async function fetchAndSetLanguageMap(fyo: Fyo, code: string) {
  const { success, message, languageMap } = await getShellDemux(
    fyo.isElectron
  ).getLanguageMap(code);

  if (!success) {
    const { showToast } = await import('src/utils/interactive');
    showToast({ type: 'error', message });
  } else {
    setLanguageMapOnTranslationString(languageMap);
    await fyo.db.translateSchemaMap(languageMap);
  }

  return success;
}
