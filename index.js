const { makeWASocket, useMultiFileAuthState, delay } = require('@whiskeysockets/baileys');
const pino = require('pino');
const fs = require('fs');
const NodeCache = require('node-cache');
const util = require('util');

let qrCode = null;
let reconnectAttempts = 0;
const maxReconnectAttempts = 5;

function logToFile(data) {
  const log_file = fs.createWriteStream(__dirname + '/debug.log', {flags : 'a'});
  log_file.write(util.format(data) + '\n');
}

function decodeMessage(message) {
  if (typeof message === 'string') {
    return Buffer.from(message, 'utf-8').toString();
  }
  return message;
}

async function connectWhatsapp() {
  try {
    console.log('Memulai koneksi WhatsApp...');
    logToFile('Memulai koneksi WhatsApp...');
    const auth = await useMultiFileAuthState("sessionDir");
    const msgRetryCounterCache = new NodeCache()

    const socket = makeWASocket({
      printQRInTerminal: true, // Ubah ke true agar QR code dicetak di log
      browser: ["DAPABOT", "", ""],
      auth: auth.state,
      logger: pino({ level: "silent" }),
      msgRetryCounterMap: msgRetryCounterCache,
      defaultQueryTimeoutMs: 60000,
      connectTimeoutMs: 60000,
      retryRequestDelayMs: 5000,
      patchMessageBeforeSending: (message) => {
        const requiresPatch = !!(
          message.buttonsMessage ||
          message.templateMessage ||
          message.listMessage
        );
        if (requiresPatch) {
          message = {
            viewOnceMessage: {
              message: {
                messageContextInfo: {
                  deviceListMetadataVersion: 2,
                  deviceListMetadata: {},
                },
                ...message,
              },
            },
          };
        }
        return message;
      },
    });

    socket.ev.on("creds.update", auth.saveCreds);

    socket.ev.on("connection.update", ({ connection, qr }) => {
      if (connection === 'open') {
        console.log("WhatsApp Active..");
        console.log('Bot ID:', socket.user.id);
        logToFile("WhatsApp Active..");
        logToFile('Bot ID: ' + socket.user.id);
        qrCode = null;
        reconnectAttempts = 0;
      } else if (connection === 'close') {
        console.log("WhatsApp Closed..");
        logToFile("WhatsApp Closed..");
        reconnect();
      } else if (connection === 'connecting') {
        console.log('WhatsApp Connecting');
        logToFile('WhatsApp Connecting');
      }
      if (qr) {
        console.log('New QR Code:', qr);
        logToFile('New QR Code: ' + qr);
        qrCode = qr;
      }
    });

    socket.ev.on("messages.upsert", async ({ messages }) => {
      try {
        const message = messages[0];
        console.log('Raw message:', JSON.stringify(message, null, 2));
        logToFile('Raw message: ' + JSON.stringify(message, null, 2));

        let pesan = '';
        let isGroupMessage = message.key.remoteJid.endsWith('@g.us');
        let isMentioned = false;

        // Ekstrak pesan
        if (message.message && message.message.conversation) {
          pesan = decodeMessage(message.message.conversation);
        } else if (message.message && message.message.extendedTextMessage && message.message.extendedTextMessage.text) {
          pesan = decodeMessage(message.message.extendedTextMessage.text);
        } else {
          console.log('Unsupported message type');
          logToFile('Unsupported message type');
          return;
        }

        // Cek apakah pesan mengandung mention
        const botNumber = socket.user.id.split(':')[0];
        isMentioned = pesan.includes(`@${botNumber}`);

        const phone = message.key.remoteJid;
        console.log('Decoded message:', pesan);
        logToFile('Decoded message: ' + pesan);
        console.log('Is Group Message:', isGroupMessage);
        console.log('Is Mentioned:', isMentioned);
        console.log('Bot Number:', botNumber);
        logToFile(`Is Group Message: ${isGroupMessage}, Is Mentioned: ${isMentioned}, Bot Number: ${botNumber}`);

        if (!message.key.fromMe) {
          if (!isGroupMessage || (isGroupMessage && isMentioned)) {
            console.log('Processing message. isGroupMessage:', isGroupMessage, 'isMentioned:', isMentioned);
            logToFile(`Processing message. isGroupMessage: ${isGroupMessage}, isMentioned: ${isMentioned}`);
            const response = await query({ "question": pesan });
            console.log('API response:', response);
            logToFile('API response: ' + JSON.stringify(response));
            const { text } = response;
            await sendMessageWithRetry(socket, phone, { text: text });
          } else {
            console.log('Pesan grup diabaikan karena bot tidak di-tag');
            logToFile('Pesan grup diabaikan karena bot tidak di-tag');
          }
        }
      } catch (error) {
        console.error('Error saat memproses pesan:', error);
        logToFile('Error saat memproses pesan: ' + error.message);
        if (error.name === 'TimeoutError' || (error.output && error.output.statusCode === 408)) {
          console.log('Timeout saat mengirim pesan. Mencoba reconnect...');
          logToFile('Timeout saat mengirim pesan. Mencoba reconnect...');
          reconnect();
        } else {
          console.log('Error tidak dikenal:', error.message);
          logToFile('Error tidak dikenal: ' + error.message);
        }
      }
    });

  } catch (error) {
    console.error('Error saat menghubungkan ke WhatsApp:', error);
    logToFile('Error saat menghubungkan ke WhatsApp: ' + error.message);
    reconnect();
  }
}

async function sendMessageWithRetry(socket, recipient, message, maxRetries = 3) {
  for (let i = 0; i < maxRetries; i++) {
    try {
      await delay(i * 2000);
      await socket.sendMessage(recipient, message);
      console.log('Pesan berhasil dikirim');
      logToFile('Pesan berhasil dikirim');
      return;
    } catch (error) {
      console.error(`Gagal mengirim pesan (percobaan ${i + 1}):`, error);
      logToFile(`Gagal mengirim pesan (percobaan ${i + 1}): ${error.message}`);
      if (i === maxRetries - 1) {
        throw error;
      }
    }
  }
}

function reconnect() {
  if (reconnectAttempts < maxReconnectAttempts) {
    console.log(`Mencoba reconnect... (Percobaan ${reconnectAttempts + 1})`);
    logToFile(`Mencoba reconnect... (Percobaan ${reconnectAttempts + 1})`);
    setTimeout(() => {
      console.log('Memulai ulang koneksi WhatsApp...');
      logToFile('Memulai ulang koneksi WhatsApp...');
      connectWhatsapp();
    }, 10000);
    reconnectAttempts++;
  } else {
    console.log('Gagal reconnect setelah beberapa percobaan. Silakan restart aplikasi.');
    logToFile('Gagal reconnect setelah beberapa percobaan. Silakan restart aplikasi.');
  }
}

async function query(data) {
  try {
    const response = await fetch(
      "https://geghnreb.cloud.sealos.io/api/v1/prediction/28a6b79e-bd21-436c-ae21-317eee710cb0",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify(data)
      }
    );
    const result = await response.json();
    return result;
  } catch (error) {
    console.error('Error saat melakukan query:', error);
    logToFile('Error saat melakukan query: ' + error.message);
    throw error;
  }
}

module.exports = { connectWhatsapp, getQRCode: () => qrCode };