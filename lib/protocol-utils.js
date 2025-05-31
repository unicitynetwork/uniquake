/**
 * UniQuake protocol utilities for handling WebRTC signaling
 * and Quake OOB (out-of-band) message formatting
 */

/**
 * Format an out-of-band (OOB) message with Quake3 protocol formatting
 * @param {string} data - The message data to format
 * @returns {ArrayBuffer} - Formatted binary message
 */
function formatOOB(data) {
  const str = '\xff\xff\xff\xff' + data + '\x00';
  
  const buffer = new ArrayBuffer(str.length);
  const view = new Uint8Array(buffer);
  
  for (let i = 0; i < str.length; i++) {
    view[i] = str.charCodeAt(i);
  }
  
  return buffer;
}

/**
 * Strip OOB formatting from a message and return the content
 * @param {ArrayBuffer} buffer - The binary message to parse
 * @returns {string|null} - The message content or null if invalid
 */
function stripOOB(buffer) {
  const view = new DataView(buffer);
  
  if (view.getInt32(0) !== -1) {
    return null;
  }
  
  let str = '';
  for (let i = 4; i < buffer.byteLength - 1; i++) {
    str += String.fromCharCode(view.getUint8(i));
  }
  
  return str;
}

/**
 * Parse a JSON string safely
 * @param {string} data - The JSON string to parse
 * @returns {object|null} - The parsed object or null on error
 */
function parseJSON(data) {
  try {
    return JSON.parse(data);
  } catch (e) {
    return null;
  }
}

/**
 * Convert binary WebRTC data channel message to/from Quake format
 * @param {ArrayBuffer} data - The binary data
 * @returns {ArrayBuffer} - Formatted data for WebRTC
 */
function formatForWebRTC(data) {
  // WebRTC DataChannel can handle binary data directly
  return data;
}

/**
 * Create WebRTC signaling message
 * @param {string} type - The message type
 * @param {object} payload - The message payload
 * @returns {string} - JSON-formatted message
 */
function createSignalingMessage(type, payload) {
  return JSON.stringify({
    type: type,
    ...payload,
    timestamp: Date.now()
  });
}

module.exports = {
  formatOOB,
  stripOOB,
  parseJSON,
  formatForWebRTC,
  createSignalingMessage
};