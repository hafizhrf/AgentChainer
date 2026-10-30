/** A list row is one line: a pasted line break, with the spaces around it, becomes one space. */
export const oneLine = (text: string) => text.replace(/\s*[\r\n]+\s*/g, " ");
