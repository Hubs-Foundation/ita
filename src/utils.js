function getTimeString() {
  const p = n => (n < 10 ? `0${n}` : n);
  const d = new Date();
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}${p(d.getHours())}${p(d.getMinutes())}${p(
    d.getSeconds()
  )}`;
}

module.exports = { getTimeString };
