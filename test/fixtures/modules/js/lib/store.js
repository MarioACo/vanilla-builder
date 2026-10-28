// Estado compartido: debe existir una sola instancia aunque lo importen varias entradas.
export const store = { count: 0 };

export function incrementar() {
  store.count += 1;
}
