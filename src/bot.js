import makeWASocket, {
    DisconnectReason,
    useMultiFileAuthState,
    fetchLatestBaileysVersion,
    makeCacheableSignalKeyStore,
    delay,
    isJidBroadcast
} from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import pino from 'pino';
import path from 'path';
import { fileURLToPath } from 'url';
import QRCode from 'qrcode';
import { DateTime } from 'luxon';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Logger configuration
const logger = pino({
    level: process.env.LOG_LEVEL || 'info',
    timestamp: () => `,"time":"${new Date().toISOString()}"`
});

// Bot configuration
const BOT_NAME = process.env.BOT_NAME || 'Remo';
const CREATOR_JID = '8801316655254@s.whatsapp.net';
const TIMEZONE = 'Asia/Dhaka';

// Bot state
let botSocket = null;
let isConnected = false;
let connectionRetries = 0;
const MAX_RETRIES = 5;

/**
 * Create and configure WhatsApp bot connection
 * @param {Object} options - Bot configuration options
 * @param {Function} options.onQRGenerated - Callback when QR is generated
 * @param {Function} options.onStatusChange - Callback when status changes
 * @param {Function} options.onConnected - Callback when connected
 * @param {Function} options.onDisconnected - Callback when disconnected
 * @returns {Promise<Object>} WhatsApp socket instance
 */
export async function createBot(options = {}) {
    const { 
        onQRGenerated, 
        onStatusChange, 
        onConnected, 
        onDisconnected 
    } = options;
    
    console.log(`🤖 Initializing ${BOT_NAME} WhatsApp Bot...`);
    
    try {
        // Update status
        if (onStatusChange) onStatusChange('initializing');
        
        // Auth state management
        const { state, saveCreds } = await useMultiFileAuthState(
            path.join(__dirname, '..', '..', 'auth_info_multi')
        );
        
        // Fetch latest version
        const { version } = await fetchLatestBaileysVersion();
        console.log(`📱 Using WhatsApp version: ${version.join('.')}`);
        
        // Create socket
        const sock = makeWASocket({
            version,
            logger,
            printQRInTerminal: true,
            auth: {
                creds: state.creds,
                keys: makeCacheableSignalKeyStore(state.keys, logger)
            },
            generateHighQualityLinkPreview: true,
            syncFullHistory: false,
            markOnlineOnConnect: true,
            getMessage: async (key) => {
                // For message retry/reply functionality
                return {
                    conversation: "Message not found"
                };
            }
        });
        
        botSocket = sock;
        
        // Save credentials when updated
        sock.ev.on('creds.update', saveCreds);
        
        // Handle connection events
        sock.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect, qr } = update;
            
            // Handle QR code generation
            if (qr) {
                console.log('📲 QR code generated for pairing');
                if (onStatusChange) onStatusChange('qr_ready');
                
                if (onQRGenerated) {
                    try {
                        // Generate QR code as data URL for web display
                        const qrDataUrl = await QRCode.toDataURL(qr);
                        onQRGenerated(qrDataUrl);
                    } catch (error) {
                        console.error('Error generating QR data URL:', error.message);
                        // Fallback to raw QR string
                        onQRGenerated(qr);
                    }
                }
            }
            
            // Handle connection close
            if (connection === 'close') {
                isConnected = false;
                const statusCode = (lastDisconnect?.error instanceof Boom)?.output?.statusCode;
                const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
                
                console.log(`⚠️ Connection closed: ${lastDisconnect?.error?.message || 'unknown reason'}`);
                console.log(`Reconnectable: ${shouldReconnect}`);
                
                if (onDisconnected) onDisconnected();
                if (onStatusChange) onStatusChange('disconnected');
                
                // Reset retry counter if it was a successful connection before
                if (statusCode === DisconnectReason.connectionClosed) {
                    connectionRetries = 0;
                }
                
                if (shouldReconnect && connectionRetries < MAX_RETRIES) {
                    connectionRetries++;
                    const delayTime = Math.min(1000 * Math.pow(2, connectionRetries), 30000); // Exponential backoff
                    console.log(`🔄 Reconnecting in ${delayTime/1000} seconds... (Attempt ${connectionRetries}/${MAX_RETRIES})`);
                    
                    await delay(delayTime);
                    return createBot(options);
                } else if (!shouldReconnect) {
                    console.log('❌ Cannot reconnect - logged out. Please scan QR code again.');
                    console.log('💡 Delete auth_info_multi folder to reset authentication.');
                } else {
                    console.log(`❌ Max reconnection attempts (${MAX_RETRIES}) reached. Restart the bot.`);
                }
            }
            
            // Handle connecting state
            if (connection === 'connecting') {
                console.log('🔗 Connecting to WhatsApp...');
                if (onStatusChange) onStatusChange('connecting');
            }
            
            // Handle connection open
            if (connection === 'open') {
                isConnected = true;
                connectionRetries = 0; // Reset retry counter on successful connection
                console.log('✅ Connected to WhatsApp successfully!');
                
                if (onConnected) onConnected();
                if (onStatusChange) onStatusChange('connected');
                
                // Update presence
                await sock.sendPresenceUpdate('available');
                
                // Send startup message to creator
                await sendStartupMessage(sock);
                
                // Announce to all admins (optional)
                await notifyAdmins(sock);
            }
        });
        
        // Message event handler
        sock.ev.on('messages.upsert', async (m) => {
            try {
                await handleMessagesUpsert(sock, m);
            } catch (error) {
                console.error('Error in message handler:', error.message);
            }
        });
        
        // Handle message receipts (read, delivery, etc.)
        sock.ev.on('messages.update', (messageUpdates) => {
            for (const update of messageUpdates) {
                if (update.update?.status) {
                    // You can log message status changes if needed
                    // console.log(`Message ${update.key.id} status: ${update.update.status}`);
                }
            }
        });
        
        // Handle group participants update
        sock.ev.on('group-participants.update', async (update) => {
            await handleGroupParticipantsUpdate(sock, update);
        });
        
        // Handle group metadata update
        sock.ev.on('groups.update', (updates) => {
            for (const update of updates) {
                console.log(`Group ${update.id} updated: ${update.subject || 'Unknown change'}`);
            }
        });
        
        console.log(`🤖 ${BOT_NAME} bot initialized and ready for connection`);
        return sock;
        
    } catch (error) {
        console.error('❌ Failed to create bot:', error.message);
        if (onStatusChange) onStatusChange('error');
        throw error;
    }
}

/**
 * Send startup message to creator
 * @param {Object} sock - WhatsApp socket
 */
async function sendStartupMessage(sock) {
    try {
        const now = DateTime.now().setZone(TIMEZONE);
        const startupMessage = 
            `🤖 *${BOT_NAME} Bot Started*\n\n` +
            `• Time: ${now.toLocaleString(DateTime.DATETIME_FULL)}\n` +
            `• Status: Connected & Online\n` +
            `• Server: ${process.env.RENDER_EXTERNAL_URL || 'Local Development'}\n` +
            `• Timezone: ${TIMEZONE}\n\n` +
            `Send *!help* to see available commands.\n\n` +
            `_Powered by Lume m1_`;
        
        await sock.sendMessage(CREATOR_JID, { text: startupMessage });
        console.log('📤 Startup message sent to creator');
    } catch (error) {
        console.log('Note: Could not send startup message to creator');
    }
}

/**
 * Notify all admins about bot startup
 * @param {Object} sock - WhatsApp socket
 */
async function notifyAdmins(sock) {
    try {
        const { getAdminList } = await import('./utils/admin.js');
        const adminList = await getAdminList();
        
        const notification = 
            `🤖 *${BOT_NAME} Bot is Now Online*\n\n` +
            `The bot has been restarted and is now connected.\n` +
            `Send *!help* to see available commands.\n\n` +
            `_Automated notification_`;
        
        // Notify creator (already done, but included for consistency)
        try {
            await sock.sendMessage(CREATOR_JID, { text: notification });
        } catch (error) {
            // Ignore if already sent
        }
        
        // Notify other admins
        for (const adminJid of adminList.admins) {
            if (adminJid !== CREATOR_JID) {
                try {
                    await sock.sendMessage(adminJid, { text: notification });
                    console.log(`📤 Notified admin: ${formatJID(adminJid)}`);
                } catch (error) {
                    console.log(`Could not notify admin ${formatJID(adminJid)}: ${error.message}`);
                }
            }
        }
    } catch (error) {
        console.error('Error notifying admins:', error.message);
    }
}

/**
 * Handle incoming messages
 * @param {Object} sock - WhatsApp socket
 * @param {Object} m - Message upsert event
 */
async function handleMessagesUpsert(sock, m) {
    // Skip if not a new message
    if (m.type !== 'notify') return;
    
    for (const msg of m.messages) {
        // Skip if no message content
        if (!msg.message) continue;
        
        // Skip messages from the bot itself
        if (msg.key.fromMe) continue;
        
        // Skip broadcast messages unless we want to handle them
        if (isJidBroadcast(msg.key.remoteJid)) {
            console.log('Skipping broadcast message');
            continue;
        }
        
        // Extract message details
        const jid = msg.key.remoteJid;
        const pushName = msg.pushName || 'User';
        const isGroup = jid.endsWith('@g.us');
        const sender = msg.key.participant || jid;
        
        // Extract message text
        let text = '';
        let messageType = '';
        
        // Handle different message types
        const messageContent = msg.message;
        
        if (messageContent.conversation) {
            text = messageContent.conversation;
            messageType = 'conversation';
        } else if (messageContent.extendedTextMessage) {
            text = messageContent.extendedTextMessage.text;
            messageType = 'extendedText';
        } else if (messageContent.imageMessage) {
            text = messageContent.imageMessage.caption || '';
            messageType = 'image';
        } else if (messageContent.videoMessage) {
            text = messageContent.videoMessage.caption || '';
            messageType = 'video';
        } else if (messageContent.documentMessage) {
            text = messageContent.documentMessage.caption || '';
            messageType = 'document';
        } else {
            // Unsupported message type
            console.log(`Unhandled message type from ${pushName}: ${Object.keys(messageContent)[0]}`);
            continue;
        }
        
        // Log received message
        const timestamp = DateTime.now().setZone(TIMEZONE).toFormat('HH:mm:ss');
        const logPrefix = isGroup ? `[GROUP:${jid.split('@')[0].slice(-4)}]` : '[PRIVATE]';
        console.log(`${logPrefix} 📩 [${timestamp}] ${pushName}: ${text || `[${messageType}]`}`);
        
        // Handle commands (only if there's text)
        if (text.trim()) {
            await handleCommand(sock, {
                jid,
                sender,
                text: text.trim(),
                pushName,
                isGroup,
                messageType,
                originalMsg: msg
            });
        }
    }
}

/**
 * Handle incoming commands
 * @param {Object} sock - WhatsApp socket
 * @param {Object} params - Command parameters
 */
async function handleCommand(sock, params) {
    const { jid, sender, text, pushName, isGroup, messageType, originalMsg } = params;
    
    try {
        // Import admin functions
        const { isAdmin, isCreator } = await import('./utils/admin.js');
        
        // Check if user is admin
        const isUserAdmin = await isAdmin(sender);
        const isUserCreator = isCreator(sender);
        
        // Convert to lowercase for command checking (but keep original for some commands)
        const lowerText = text.toLowerCase();
        
        // Command routing
        if (lowerText === '!ping' || lowerText === '/ping') {
            await sock.sendMessage(jid, { text: '🏓 Pong!' });
            return;
        }
        
        if (lowerText === '!help' || lowerText === '/help' || lowerText === '!start') {
            await sendHelpMessage(sock, jid, isUserAdmin, isGroup);
            return;
        }
        
        if (lowerText === '!info' || lowerText === '/info') {
            await sendBotInfo(sock, jid);
            return;
        }
        
        if (lowerText === '!time' || lowerText === '/time') {
            await sendCurrentTime(sock, jid);
            return;
        }
        
        if (lowerText === '!admins' || lowerText === '/admins') {
            await handleAdminsCommand(sock, jid, isUserAdmin);
            return;
        }
        
        if (lowerText.startsWith('!promote') || lowerText.startsWith('/promote')) {
            await handlePromoteCommand(sock, jid, sender, text, isUserAdmin, isUserCreator);
            return;
        }
        
        if (lowerText.startsWith('!demote') || lowerText.startsWith('/demote')) {
            await handleDemoteCommand(sock, jid, sender, text, isUserAdmin, isUserCreator);
            return;
        }
        
        if (lowerText.startsWith('!broadcast') || lowerText.startsWith('/broadcast')) {
            await handleBroadcastCommand(sock, jid, sender, text, isUserAdmin);
            return;
        }
        
        if (lowerText.startsWith('!addreminder') || lowerText.startsWith('/addreminder')) {
            await handleAddReminder(sock, jid, sender, text, pushName);
            return;
        }
        
        if (lowerText.startsWith('!myreminders') || lowerText.startsWith('/myreminders')) {
            await handleMyReminders(sock, jid, sender);
            return;
        }
        
        if (lowerText.startsWith('!cancelreminder') || lowerText.startsWith('/cancelreminder')) {
            await handleCancelReminder(sock, jid, sender, text);
            return;
        }
        
        // Natural language reminder detection
        if (text.toLowerCase().includes('remind me') || 
            text.toLowerCase().includes('reminder') ||
            text.toLowerCase().includes('alarm')) {
            await handleNaturalReminder(sock, jid, sender, text, pushName);
            return;
        }
        
        // Unknown command response (only for commands starting with ! or /)
        if (text.startsWith('!') || text.startsWith('/')) {
            await sock.sendMessage(jid, {
                text: `❓ Unknown command. Type *!help* to see available commands.\n\n` +
                      `_Did you mean to set a reminder? Try: "remind me in 2 hours to call mom"_`
            });
        }
        
    } catch (error) {
        console.error(`Error handling command from ${pushName}: ${error.message}`);
        
        // Send error message to user
        try {
            await sock.sendMessage(jid, {
                text: `⚠️ An error occurred while processing your command.\n\n` +
                      `Error: ${error.message}\n\n` +
                      `Please try again or contact the bot administrator.`
            });
        } catch (sendError) {
            console.error('Failed to send error message:', sendError.message);
        }
    }
}

/**
 * Send help message based on user role
 */
async function sendHelpMessage(sock, jid, isUserAdmin, isGroup) {
    let helpText = 
        `🤖 *${BOT_NAME} – WhatsApp Reminder Bot*\n` +
        `_Powered by Lume m1_\n\n` +
        `📝 *Available Commands:*\n\n` +
        `• *!help* - Show this message\n` +
        `• *!info* - Bot information\n` +
        `• *!time* - Current time (${TIMEZONE})\n` +
        `• *!ping* - Check if bot is alive\n` +
        `• *!admins* - List bot admins (admin only)\n\n` +
        `⏰ *Reminder Commands:*\n` +
        `• *!addreminder <time> <message>* - Add a reminder\n` +
        `• *!myreminders* - List your reminders\n` +
        `• *!cancelreminder <id>* - Cancel a reminder\n\n` +
        `💬 *Natural Language Examples:*\n` +
        `• remind me in 2 hours to call mom\n` +
        `• remind me tomorrow 9am drink water\n` +
        `• every day at 8pm take medicine\n`;
    
    if (isUserAdmin) {
        helpText += `\n👑 *Admin Commands:*\n` +
                   `• *!promote <number>* - Promote user to admin\n` +
                   `• *!demote <number>* - Demote user from admin\n` +
                   `• *!broadcast <message>* - Broadcast to all users\n`;
    }
    
    if (isGroup) {
        helpText += `\n📌 *Note:* In groups, mention the bot or use commands in replies.`;
    }
    
    helpText += `\n\n_Developer: Chitron Bhattacharjee_`;
    
    await sock.sendMessage(jid, { text: helpText });
}

/**
 * Send bot information
 */
async function sendBotInfo(sock, jid) {
    const now = DateTime.now().setZone(TIMEZONE);
    const uptime = process.uptime();
    const uptimeStr = formatUptime(uptime);
    
    const infoText = 
        `🤖 *${BOT_NAME} Bot Information*\n\n` +
        `• Creator: Chitron Bhattacharjee\n` +
        `• Version: 1.0.0\n` +
        `• Timezone: ${TIMEZONE}\n` +
        `• Current Time: ${now.toLocaleString(DateTime.DATETIME_FULL)}\n` +
        `• Uptime: ${uptimeStr}\n` +
        `• Status: ${isConnected ? 'Connected ✅' : 'Disconnected ❌'}\n` +
        `• Storage: JSON files (no database)\n\n` +
        `_Powered by Lume m1_\n` +
        `_Built with @whiskeysockets/baileys_`;
    
    await sock.sendMessage(jid, { text: infoText });
}

/**
 * Send current time
 */
async function sendCurrentTime(sock, jid) {
    const now = DateTime.now().setZone(TIMEZONE);
    
    const timeText = 
        `⏰ *Current Time*\n\n` +
        `• Date: ${now.toLocaleString(DateTime.DATE_FULL)}\n` +
        `• Time: ${now.toLocaleString(DateTime.TIME_WITH_SECONDS)}\n` +
        `• Timezone: ${TIMEZONE}\n` +
        `• Day: ${now.weekdayLong}\n\n` +
        `_${now.toRelative()}_`;
    
    await sock.sendMessage(jid, { text: timeText });
}

/**
 * Handle admins command
 */
async function handleAdminsCommand(sock, jid, isUserAdmin) {
    if (!isUserAdmin) {
        await sock.sendMessage(jid, {
            text: `⛔ This command is only available to administrators.`
        });
        return;
    }
    
    const { getAdminList } = await import('./utils/admin.js');
    const adminList = await getAdminList();
    
    let adminText = `👑 *${BOT_NAME} Admin List*\n\n`;
    adminText += `• *Creator:* ${formatJID(adminList.creator)}\n\n`;
    
    if (adminList.admins.length > 0) {
        adminText += `• *Administrators:*\n`;
        adminList.admins.forEach((adminJid, index) => {
            adminText += `  ${index + 1}. ${formatJID(adminJid)}\n`;
        });
        adminText += `\n_Total admins: ${adminList.admins.length}_`;
    } else {
        adminText += `• *Administrators:* None (only creator)\n`;
        adminText += `\n_Use !promote <number> to add administrators_`;
    }
    
    await sock.sendMessage(jid, { text: adminText });
}

/**
 * Handle promote command
 */
async function handlePromoteCommand(sock, jid, sender, text, isUserAdmin, isUserCreator) {
    if (!isUserAdmin) {
        await sock.sendMessage(jid, {
            text: `⛔ Admin commands are restricted to administrators only.`
        });
        return;
    }
    
    if (!isUserCreator) {
        await sock.sendMessage(jid, {
            text: `⛔ Only the creator can promote/demote administrators.`
        });
        return;
    }
    
    const { promoteAdmin } = await import('./utils/admin.js');
    
    // Extract phone number from command
    const parts = text.split(' ');
    if (parts.length < 2) {
        await sock.sendMessage(jid, {
            text: `📝 *Usage:* !promote <phone_number>\n\n` +
                  `*Example:* !promote 8801712345678\n` +
                  `*Note:* Use Bangladeshi numbers (8801XXXXXXXXX)`
        });
        return;
    }
    
    const phoneNumber = parts[1].replace(/\D/g, ''); // Remove non-digits
    
    // Validate phone number
    if (!phoneNumber.startsWith('880') || phoneNumber.length !== 13) {
        await sock.sendMessage(jid, {
            text: `❌ Invalid Bangladeshi phone number format.\n\n` +
                  `*Required:* 8801XXXXXXXXX (13 digits total)\n` +
                  `*You entered:* ${phoneNumber || 'empty'}`
        });
        return;
    }
    
    const targetJid = `${phoneNumber}@s.whatsapp.net`;
    const result = await promoteAdmin(sender, targetJid);
    
    await sock.sendMessage(jid, { text: result.message });
    
    // Notify the promoted user if successful
    if (result.success) {
        try {
            await sock.sendMessage(targetJid, {
                text: `👑 *You have been promoted to Administrator!*\n\n` +
                      `Congratulations! You now have administrator privileges in ${BOT_NAME} Bot.\n\n` +
                      `• You can use admin commands\n` +
                      `• You can manage reminders\n` +
                      `• Type !help to see all commands\n\n` +
                      `_Promoted by: ${formatJID(sender)}_`
            });
            console.log(`✅ Successfully promoted ${targetJid} to admin`);
        } catch (error) {
            console.log(`Note: Could not notify promoted user ${targetJid} (they may not have messaged the bot yet)`);
        }
    }
}

/**
 * Handle demote command
 */
async function handleDemoteCommand(sock, jid, sender, text, isUserAdmin, isUserCreator) {
    if (!isUserAdmin) {
        await sock.sendMessage(jid, {
            text: `⛔ Admin commands are restricted to administrators only.`
        });
        return;
    }
    
    if (!isUserCreator) {
        await sock.sendMessage(jid, {
            text: `⛔ Only the creator can promote/demote administrators.`
        });
        return;
    }
    
    const { demoteAdmin } = await import('./utils/admin.js');
    
    const parts = text.split(' ');
    if (parts.length < 2) {
        await sock.sendMessage(jid, {
            text: `📝 *Usage:* !demote <phone_number>\n\n` +
                  `*Example:* !demote 8801712345678`
        });
        return;
    }
    
    const phoneNumber = parts[1].replace(/\D/g, '');
    
    if (!phoneNumber.startsWith('880') || phoneNumber.length !== 13) {
        await sock.sendMessage(jid, {
            text: `❌ Invalid Bangladeshi phone number format.`
        });
        return;
    }
    
    const targetJid = `${phoneNumber}@s.whatsapp.net`;
    const result = await demoteAdmin(sender, targetJid);
    
    await sock.sendMessage(jid, { text: result.message });
    
    // Notify the demoted user if successful
    if (result.success) {
        try {
            await sock.sendMessage(targetJid, {
                text: `📉 *Your Administrator privileges have been removed.*\n\n` +
                      `You no longer have administrator access in ${BOT_NAME} Bot.\n\n` +
                      `_Demoted by: ${formatJID(sender)}_`
            });
        } catch (error) {
            console.log(`Note: Could not notify demoted user ${targetJid}`);
        }
    }
}

/**
 * Handle broadcast command
 */
async function handleBroadcastCommand(sock, jid, sender, text, isUserAdmin) {
    if (!isUserAdmin) {
        await sock.sendMessage(jid, {
            text: `⛔ Admin commands are restricted.`
        });
        return;
    }
    
    const broadcastMessage = text.substring(text.indexOf(' ') + 1).trim();
    
    if (!broadcastMessage) {
        await sock.sendMessage(jid, {
            text: `📝 *Usage:* !broadcast <message>\n\n` +
                  `*Example:* !broadcast Bot will be offline for maintenance at 10PM`
        });
        return;
    }
    
    // Get list of users who have interacted with bot (from reminders)
    try {
        const { getUserReminders } = await import('./services/reminder.js');
        // We'll need to track users separately for broadcast
        // For now, send to creator and admins only
        
        const { getAdminList } = await import('./utils/admin.js');
        const adminList = await getAdminList();
        
        const broadcastText = 
            `📢 *Broadcast from ${BOT_NAME} Bot*\n\n` +
            `${broadcastMessage}\n\n` +
            `_Sent by: ${formatJID(sender)}_`;
        
        // Send to creator
        try {
            await sock.sendMessage(CREATOR_JID, { text: broadcastText });
        } catch (error) {
            console.log('Could not broadcast to creator');
        }
        
        // Send to other admins
        for (const adminJid of adminList.admins) {
            if (adminJid !== CREATOR_JID && adminJid !== sender) {
                try {
                    await sock.sendMessage(adminJid, { text: broadcastText });
                    await delay(1000); // Delay to avoid rate limiting
                } catch (error) {
                    console.log(`Could not broadcast to admin ${formatJID(adminJid)}`);
                }
            }
        }
        
        await sock.sendMessage(jid, {
            text: `✅ Broadcast sent to ${adminList.admins.length + 1} recipients.`
        });
        
    } catch (error) {
        console.error('Broadcast failed:', error.message);
        await sock.sendMessage(jid, {
            text: `❌ Broadcast failed: ${error.message}`
        });
    }
}

/**
 * Handle add reminder command
 */
async function handleAddReminder(sock, jid, sender, text, pushName) {
    try {
        // Remove command prefix and parse
        const reminderText = text.substring(text.indexOf(' ') + 1).trim();
        
        if (!reminderText) {
            await sock.sendMessage(jid, {
                text: `📝 *Usage:* !addreminder <time> <message>\n\n` +
                      `*Examples:*\n` +
                      `• !addreminder 2h Call mom\n` +
                      `• !addreminder tomorrow 9am Meeting\n` +
                      `• !addreminder daily 8pm Take medicine`
            });
            return;
        }
        
        // Parse natural language time
        const parsedTime = parseNaturalTime(reminderText);
        
        if (!parsedTime) {
            await sock.sendMessage(jid, {
                text: `❌ Could not understand the time format.\n\n` +
                      `*Valid formats:*\n` +
                      `• "in 2 hours"\n` +
                      `• "tomorrow 9am"\n` +
                      `• "daily at 8pm"\n` +
                      `• "next monday 10:30"`
            });
            return;
        }
        
        const { createReminder } = await import('./services/reminder.js');
        const reminder = await createReminder(
            jid,
            sender,
            parsedTime.message,
            parsedTime.dueAt
        );
        
        const dueTime = DateTime.fromISO(reminder.dueAt).setZone(TIMEZONE);
        const timeUntil = dueTime.toRelative();
        
        await sock.sendMessage(jid, {
            text: `✅ *Reminder Set!*\n\n` +
                  `• Message: ${reminder.text}\n` +
                  `• Time: ${dueTime.toLocaleString(DateTime.DATETIME_FULL)}\n` +
                  `• ID: ${reminder.id.slice(0, 8)}\n` +
                  `• Status: ${reminder.status}\n\n` +
                  `_I'll remind you ${timeUntil}_`
        });
        
        console.log(`✅ Reminder created for ${pushName}: ${reminder.id}`);
        
    } catch (error) {
        console.error('Error creating reminder:', error.message);
        await sock.sendMessage(jid, {
            text: `❌ Failed to create reminder: ${error.message}`
        });
    }
}

/**
 * Handle my reminders command
 */
async function handleMyReminders(sock, jid, sender) {
    try {
        const { getUserReminders } = await import('./services/reminder.js');
        const reminders = await getUserReminders(sender);
        
        const pendingReminders = reminders.filter(r => r.status === 'pending');
        
        if (pendingReminders.length === 0) {
            await sock.sendMessage(jid, {
                text: `📭 You have no pending reminders.\n\n` +
                      `Create one with:\n` +
                      `• !addreminder <time> <message>\n` +
                      `• Or natural language: "remind me in 2 hours"`
            });
            return;
        }
        
        let remindersText = `📋 *Your Pending Reminders (${pendingReminders.length})*\n\n`;
        
        pendingReminders.forEach((reminder, index) => {
            const dueTime = DateTime.fromISO(reminder.dueAt).setZone(TIMEZONE);
            const timeUntil = dueTime.toRelative();
            
            remindersText += 
                `*${index + 1}. ${reminder.text}*\n` +
                `   ⏰ ${dueTime.toLocaleString(DateTime.DATETIME_MED)}\n` +
                `   🆔 ${reminder.id.slice(0, 8)}\n` +
                `   ⏳ ${timeUntil}\n\n`;
        });
        
        remindersText += `_Use !cancelreminder <ID> to cancel a reminder_`;
        
        await sock.sendMessage(jid, { text: remindersText });
        
    } catch (error) {
        console.error('Error getting reminders:', error.message);
        await sock.sendMessage(jid, {
            text: `❌ Failed to get your reminders: ${error.message}`
        });
    }
}

/**
 * Handle cancel reminder command
 */
async function handleCancelReminder(sock, jid, sender, text) {
    try {
        const reminderId = text.substring(text.indexOf(' ') + 1).trim();
        
        if (!reminderId) {
            await sock.sendMessage(jid, {
                text: `📝 *Usage:* !cancelreminder <reminder_id>\n\n` +
                      `Get reminder IDs from !myreminders command`
            });
            return;
        }
        
        const { deleteReminder } = await import('./services/reminder.js');
        const success = await deleteReminder(reminderId, sender);
        
        if (success) {
            await sock.sendMessage(jid, {
                text: `✅ Reminder cancelled successfully.\n\n` +
                      `ID: ${reminderId.slice(0, 8)}\n` +
                      `_Reminder has been removed._`
            });
        } else {
            await sock.sendMessage(jid, {
                text: `❌ Could not find reminder with ID: ${reminderId}\n\n` +
                      `Make sure:\n` +
                      `1. The ID is correct\n` +
                      `2. The reminder belongs to you\n` +
                      `3. The reminder hasn't already been sent/cancelled`
            });
        }
        
    } catch (error) {
        console.error('Error cancelling reminder:', error.message);
        await sock.sendMessage(jid, {
            text: `❌ Failed to cancel reminder: ${error.message}`
        });
    }
}

/**
 * Handle natural language reminder
 */
async function handleNaturalReminder(sock, jid, sender, text, pushName) {
    try {
        // Simple natural language parsing
        const parsedTime = parseNaturalTime(text);
        
        if (!parsedTime) {
            await sock.sendMessage(jid, {
                text: `🤔 I couldn't understand the time in your reminder.\n\n` +
                      `*Try these formats:*\n` +
                      `• "remind me in 2 hours to call mom"\n` +
                      `• "remind me tomorrow 9am meeting"\n` +
                      `• "remind me daily at 8pm drink water"\n\n` +
                      `Or use: !addreminder <time> <message>`
            });
            return;
        }
        
        const { createReminder } = await import('./services/reminder.js');
        const reminder = await createReminder(
            jid,
            sender,
            parsedTime.message,
            parsedTime.dueAt
        );
        
        const dueTime = DateTime.fromISO(reminder.dueAt).setZone(TIMEZONE);
        const timeUntil = dueTime.toRelative();
        
        await sock.sendMessage(jid, {
            text: `✅ *Reminder Set!*\n\n` +
                  `• Message: ${reminder.text}\n` +
                  `• Time: ${dueTime.toLocaleString(DateTime.DATETIME_FULL)}\n` +
                  `• ID: ${reminder.id.slice(0, 8)}\n\n` +
                  `_I'll remind you ${timeUntil}_`
        });
        
        console.log(`✅ Natural reminder created for ${pushName}: ${reminder.id}`);
        
    } catch (error) {
        console.error('Error creating natural reminder:', error.message);
        await sock.sendMessage(jid, {
            text: `❌ Failed to create reminder: ${error.message}\n\n` +
                  `Try using: !addreminder <time> <message>`
        });
    }
}

/**
 * Handle group participants update
 */
async function handleGroupParticipantsUpdate(sock, update) {
    try {
        const { id, participants, action } = update;
        
        // Log group event
        console.log(`👥 Group ${id}: ${action} ${participants.join(', ')}`);
        
        // Send welcome message if bot is added to group
        if (action === 'add' && participants.includes(sock.user.id.split(':')[0] + '@s.whatsapp.net')) {
            const welcomeMessage = 
                `🤖 *${BOT_NAME} Bot has joined the group!*\n\n` +
                `I'm a reminder bot that can help you set reminders.\n\n` +
                `*How to use:*\n` +
                `• Mention me with "remind me in 2 hours to call mom"\n` +
                `• Or use commands: !help for all commands\n\n` +
                `_Powered by Lume m1_`;
            
            await sock.sendMessage(id, { text: welcomeMessage });
        }
        
    } catch (error) {
        console.error('Error handling group update:', error.message);
    }
}

/**
 * Parse natural language time
 * @param {string} text - Natural language text
 * @returns {Object|null} Parsed time object or null
 */
function parseNaturalTime(text) {
    const lowerText = text.toLowerCase();
    
    // Extract message (remove trigger words)
    let message = text;
    const triggerWords = ['remind me', 'reminder', 'alarm', 'alert me'];
    
    for (const word of triggerWords) {
        if (lowerText.includes(word)) {
            message = text.substring(text.toLowerCase().indexOf(word) + word.length).trim();
            break;
        }
    }
    
    // Remove command prefix if present
    if (message.startsWith('!addreminder') || message.startsWith('/addreminder')) {
        message = message.substring(message.indexOf(' ') + 1).trim();
    }
    
    // Parse time patterns
    let dueAt = null;
    let parsedMessage = message;
    
    // Pattern 1: "in X hours/minutes"
    const inPattern = /in\s+(\d+)\s+(hour|hr|minute|min|h|m)(?:s?)\b/i;
    const inMatch = message.match(inPattern);
    
    if (inMatch) {
        const amount = parseInt(inMatch[1]);
        const unit = inMatch[2].toLowerCase();
        
        dueAt = DateTime.now().setZone(TIMEZONE);
        
        if (unit.startsWith('h')) {
            dueAt = dueAt.plus({ hours: amount });
        } else if (unit.startsWith('m')) {
            dueAt = dueAt.plus({ minutes: amount });
        }
        
        parsedMessage = message.replace(inPattern, '').replace(/\s+/g, ' ').trim();
        parsedMessage = parsedMessage.replace(/^(to|that|for)\s+/i, '').trim();
    }
    
    // Pattern 2: "tomorrow at X" or "tomorrow X"
    const tomorrowPattern = /tomorrow\s+(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i;
    const tomorrowMatch = message.match(tomorrowPattern);
    
    if (tomorrowMatch && !dueAt) {
        let hours = parseInt(tomorrowMatch[1]);
        const minutes = tomorrowMatch[2] ? parseInt(tomorrowMatch[2]) : 0;
        const ampm = tomorrowMatch[3] ? tomorrowMatch[3].toLowerCase() : null;
        
        // Convert to 24-hour format
        if (ampm === 'pm' && hours < 12) hours += 12;
        if (ampm === 'am' && hours === 12) hours = 0;
        
        dueAt = DateTime.now().setZone(TIMEZONE).plus({ days: 1 })
            .set({ hour: hours, minute: minutes, second: 0, millisecond: 0 });
        
        parsedMessage = message.replace(tomorrowPattern, '').replace(/\s+/g, ' ').trim();
        parsedMessage = parsedMessage.replace(/^(to|that|for)\s+/i, '').trim();
    }
    
    // Pattern 3: "daily at X" or "every day at X"
    const dailyPattern = /(?:daily|every\s+day)\s+(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i;
    const dailyMatch = message.match(dailyPattern);
    
    if (dailyMatch && !dueAt) {
        // For now, treat as single reminder (recurring reminders need more complex handling)
        let hours = parseInt(dailyMatch[1]);
        const minutes = dailyMatch[2] ? parseInt(dailyMatch[2]) : 0;
        const ampm = dailyMatch[3] ? dailyMatch[3].toLowerCase() : null;
        
        if (ampm === 'pm' && hours < 12) hours += 12;
        if (ampm === 'am' && hours === 12) hours = 0;
        
        dueAt = DateTime.now().setZone(TIMEZONE)
            .set({ hour: hours, minute: minutes, second: 0, millisecond: 0 });
        
        // If time already passed today, schedule for tomorrow
        if (dueAt < DateTime.now().setZone(TIMEZONE)) {
            dueAt = dueAt.plus({ days: 1 });
        }
        
        parsedMessage = message.replace(dailyPattern, '').replace(/\s+/g, ' ').trim();
        parsedMessage = `Daily: ${parsedMessage}`;
    }
    
    // If no pattern matched, try generic time parsing
    if (!dueAt) {
        // Try to extract any time-like pattern
        const timePattern = /(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i;
        const timeMatch = message.match(timePattern);
        
        if (timeMatch) {
            let hours = parseInt(timeMatch[1]);
            const minutes = timeMatch[2] ? parseInt(timeMatch[2]) : 0;
            const ampm = timeMatch[3] ? timeMatch[3].toLowerCase() : null;
            
            if (ampm === 'pm' && hours < 12) hours += 12;
            if (ampm === 'am' && hours === 12) hours = 0;
            
            dueAt = DateTime.now().setZone(TIMEZONE)
                .set({ hour: hours, minute: minutes, second: 0, millisecond: 0 });
            
            // If time already passed today, schedule for tomorrow
            if (dueAt < DateTime.now().setZone(TIMEZONE)) {
                dueAt = dueAt.plus({ days: 1 });
            }
            
            parsedMessage = message.replace(timePattern, '').replace(/\s+/g, ' ').trim();
        }
    }
    
    // Default: 1 hour from now if no time specified
    if (!dueAt) {
        dueAt = DateTime.now().setZone(TIMEZONE).plus({ hours: 1 });
        parsedMessage = message;
    }
    
    // Clean up message
    if (!parsedMessage) {
        parsedMessage = 'Reminder';
    }
    
    return {
        dueAt: dueAt,
        message: parsedMessage
    };
}

/**
 * Format JID for display
 */
function formatJID(jid) {
    if (!jid) return 'Unknown';
    return jid.replace('@s.whatsapp.net', '');
}

/**
 * Format uptime to human readable string
 */
function formatUptime(seconds) {
    const days = Math.floor(seconds / (24 * 60 * 60));
    const hours = Math.floor((seconds % (24 * 60 * 60)) / (60 * 60));
    const minutes = Math.floor((seconds % (60 * 60)) / 60);
    const secs = Math.floor(seconds % 60);
    
    const parts = [];
    if (days > 0) parts.push(`${days}d`);
    if (hours > 0) parts.push(`${hours}h`);
    if (minutes > 0) parts.push(`${minutes}m`);
    if (secs > 0 || parts.length === 0) parts.push(`${secs}s`);
    
    return parts.join(' ');
}

/**
 * Get bot socket instance
 */
export function getBotSocket() {
    return botSocket;
}

/**
 * Check if bot is connected
 */
export function isBotConnected() {
    return isConnected;
}

/**
 * Send message using bot
 */
export async function sendMessage(jid, message) {
    if (!botSocket || !isConnected) {
        throw new Error('Bot is not connected');
    }
    
    try {
        return await botSocket.sendMessage(jid, message);
    } catch (error) {
        console.error('Error sending message:', error.message);
        throw error;
    }
}

export default {
    createBot,
    getBotSocket,
    isBotConnected,
    sendMessage
};