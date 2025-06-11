/**
 * Quake binary protocol utilities
 */

/**
 * Format an out-of-band message
 * @param {string} data - Data to format
 * @returns {ArrayBuffer} Formatted message
 */
function formatOOB(data) {
  const str = "\xff\xff\xff\xff" + data + "\x00";
  
  const buffer = new ArrayBuffer(str.length);
  const view = new Uint8Array(buffer);
  
  for (let i = 0; i < str.length; i++) {
    view[i] = str.charCodeAt(i);
  }
  
  return buffer;
}

/**
 * Strip out-of-band header from message
 * @param {ArrayBuffer} buffer - Message buffer
 * @returns {string|null} Message content or null if invalid
 */
function stripOOB(buffer) {
  const view = new DataView(buffer);
  
  if (view.getInt32(0) !== -1) {
    return null;
  }
  
  let str = "";
  for (let i = 4; i < buffer.byteLength - 1; i++) {
    const c = String.fromCharCode(view.getUint8(i));
    str += c;
  }
  
  return str;
}

/**
 * Build a challenge string
 * @returns {string} Challenge string
 */
function buildChallenge() {
  const CHALLENGE_MIN_LENGTH = 9;
  const CHALLENGE_MAX_LENGTH = 12;
  
  let challenge = "";
  const length = CHALLENGE_MIN_LENGTH - 1 + 
    parseInt(Math.random() * (CHALLENGE_MAX_LENGTH - CHALLENGE_MIN_LENGTH + 1), 10);
  
  for (let i = 0; i < length; i++) {
    let c;
    do {
      c = Math.floor(Math.random() * (126 - 33 + 1) + 33); // -> 33 ... 126 (inclusive)
    } while (c === 92 || c === 59 || c === 34 || c === 37 || c === 47);
    
    challenge += String.fromCharCode(c);
  }
  
  return challenge;
}

/**
 * Parse an info string (key\value pairs)
 * @param {string} str - Info string
 * @returns {Object} Parsed info
 */
function parseInfoString(str) {
  const data = {};
  
  const split = str.split("\\");
  
  for (let i = 0; i < split.length - 1; i += 2) {
    const key = split[i];
    const value = split[i+1];
    data[key] = value;
  }
  
  return data;
}

module.exports = {
  formatOOB,
  stripOOB,
  buildChallenge,
  parseInfoString
};
