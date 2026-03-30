const DEFAULT_LOCALE = 'en';
const SUPPORTED_LOCALES = ['en', 'de', 'fr'];

export function resolveSupportedLocale(locale) {
  if (typeof locale !== 'string' || locale.trim().length === 0) {
    return DEFAULT_LOCALE;
  }

  const normalizedLocale = locale.trim().replace('_', '-').toLowerCase();
  const [primaryLanguage] = normalizedLocale.split('-');
  if (SUPPORTED_LOCALES.includes(primaryLanguage)) {
    return primaryLanguage;
  }
  return DEFAULT_LOCALE;
}

export function getCommonMessage(messages, key, fallbackValue = '') {
  if (messages && typeof messages === 'object' && typeof messages[key] === 'string') {
    return messages[key];
  }
  return fallbackValue;
}

export function formatCommonMessage(messages, key, values = {}, fallbackValue = '') {
  const template = getCommonMessage(messages, key, fallbackValue);
  return template.replace(/\{([a-zA-Z0-9_]+)\}/g, (_match, valueKey) => {
    const replacementValue = values?.[valueKey];
    return replacementValue === undefined || replacementValue === null ? '' : String(replacementValue);
  });
}

export async function loadCommonLocaleBundle(options = {}) {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch?.bind(globalThis) ?? null;
  const baseUrl = options.baseUrl ?? import.meta.url;
  const requestedLocale = options.locale ?? globalThis.navigator?.language ?? DEFAULT_LOCALE;
  const resolvedLocale = resolveSupportedLocale(requestedLocale);
  const localesToTry = resolvedLocale === DEFAULT_LOCALE ? [DEFAULT_LOCALE] : [resolvedLocale, DEFAULT_LOCALE];

  if (typeof fetchImpl !== 'function') {
    return {
      locale: resolvedLocale,
      messages: {},
    };
  }

  for (const locale of localesToTry) {
    try {
      const response = await fetchImpl(new URL(`../../locales/${locale}/common.json`, baseUrl));
      if (!response?.ok) {
        continue;
      }
      const parsed = await response.json();
      return {
        locale,
        messages: parsed && typeof parsed === 'object' ? parsed : {},
      };
    } catch (_error) {
      // Ignore locale loading failures and fall back to the next candidate/default placeholders.
    }
  }

  return {
    locale: DEFAULT_LOCALE,
    messages: {},
  };
}

export function applyCommonMessagesToDocument(doc, bundle = {}) {
  const resolvedDocument = doc ?? globalThis.document ?? null;
  if (!resolvedDocument) {
    throw new Error('document is required');
  }

  const locale = resolveSupportedLocale(bundle.locale ?? DEFAULT_LOCALE);
  const messages = bundle.messages && typeof bundle.messages === 'object' ? bundle.messages : {};

  if (resolvedDocument.documentElement) {
    resolvedDocument.documentElement.lang = locale;
  }
  resolvedDocument.title = getCommonMessage(messages, 'head.title', resolvedDocument.title);

  for (const element of resolvedDocument.querySelectorAll?.('[data-i18n]') ?? []) {
    const key = element?.getAttribute?.('data-i18n');
    if (!key) {
      continue;
    }
    const translated = getCommonMessage(messages, key, null);
    if (translated !== null) {
      element.textContent = translated;
    }
  }

  for (const element of resolvedDocument.querySelectorAll?.('*') ?? []) {
    const attributeNames = element?.getAttributeNames?.() ?? [];
    for (const attributeName of attributeNames) {
      if (!attributeName.startsWith('data-i18n-attr-')) {
        continue;
      }
      const targetAttribute = attributeName.slice('data-i18n-attr-'.length);
      const key = element.getAttribute(attributeName);
      if (!targetAttribute || !key) {
        continue;
      }
      const translated = getCommonMessage(messages, key, null);
      if (translated !== null) {
        element.setAttribute(targetAttribute, translated);
      }
    }
  }

  return {
    locale,
    messages,
  };
}
