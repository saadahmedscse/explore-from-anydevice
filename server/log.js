const useColor = Boolean(process.stdout.isTTY) && !process.env.NO_COLOR;
const wrap = (open, close) => (s) => (useColor ? `\x1b[${open}m${s}\x1b[${close}m` : String(s));

export const color = {
  orange: (s) => (useColor ? `\x1b[38;2;217;119;87m${s}\x1b[39m` : String(s)),
  dim: wrap('2', '22'),
  bold: wrap('1', '22'),
  green: (s) => (useColor ? `\x1b[38;2;140;192;132m${s}\x1b[39m` : String(s)),
};

const stamp = () => color.dim(new Date().toTimeString().slice(0, 8));

export const log = {
  info: (...args) => console.log(stamp(), ...args),
  warn: (...args) => console.warn(stamp(), color.orange('!'), ...args),
};
