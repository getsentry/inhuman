const URL = require("url").URL;
const { promisify } = require("util");
const { exec } = require("child_process");

function isLinkAllowed(link, domainList) {
  if (!domainList) return true;
  const domain = new URL(link).host;
  return domainList.find(
    d => d === "*" || ("." + domain).indexOf("." + d) !== -1
  );
}

// Ported from http://en.cppreference.com/w/cpp/algorithm/lower_bound
function lowerBound(array, value, comp) {
  let first = 0;
  let count = array.length;
  while (count > 0) {
    const step = (count / 2) | 0;
    let it = first + step;
    if (comp(array[it], value) <= 0) {
      it += 1;
      first = it;
      count -= step + 1;
    } else {
      count = step;
    }
  }
  return first;
}

const execPromise = promisify(exec);

module.exports = {
  isLinkAllowed,
  lowerBound,
  execPromise
};
