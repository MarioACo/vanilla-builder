// Idioma de los mensajes: inglés o español.
// Prioridad: --lang / setLang() > BUILDER_LANG > LC_ALL / LC_MESSAGES / LANG > idioma del sistema > inglés.
// Los campos de --json, la configuración y los nombres de fase no se traducen nunca.

function detect() {
  const env = process.env;
  const explicit = env.BUILDER_LANG;
  if (explicit) return /^es/i.test(explicit) ? 'es' : 'en';
  const posix = env.LC_ALL || env.LC_MESSAGES || env.LANG;
  // "C" y "POSIX" no dicen nada del idioma de la persona: se mira el del sistema.
  if (posix && !/^(C|POSIX)(\.|$)/i.test(posix)) return /^es/i.test(posix) ? 'es' : 'en';
  try {
    return /^es\b/i.test(Intl.DateTimeFormat().resolvedOptions().locale) ? 'es' : 'en';
  } catch {
    return 'en';
  }
}

let lang = detect();

/** Cambia el idioma ('en' o 'es'). */
export function setLang(value) {
  lang = /^es/i.test(String(value)) ? 'es' : 'en';
}

export function getLang() {
  return lang;
}

/** Devuelve el texto en el idioma activo. Ambos textos se escriben juntos en el código. */
export function L(es, en) {
  return lang === 'es' ? es : en;
}
