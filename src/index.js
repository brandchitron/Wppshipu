import 'dotenv/config';
import { createBot } from './bot.js';
import { initAdminSystem } from './utils/admin.js';
import { initReminderSystem } from './services/reminder.js';

// Bot startup banner
console.log(`
╔═══════════════════════════════════════╗
║            🤖 REMO BOT               ║
║    WhatsApp Reminder Assistant       ║
║      Powered by Lume m1              ║
║    Creator: Chitron Bhattacharjee    ║
╚═══════════════════════════════════════╝
`);

// Initialize systems
async function startBot() {
    try {
        console.log('🔧 Initializing systems...');
        
        // Initialize admin system (creates data directory and files)
        await initAdminSystem();
        
        // Initialize reminder system (skeleton for now)
        await initReminderSystem();
        
        // Start WhatsApp bot
        await createBot();
        
        console.log('🚀 Bot startup sequence complete!');
        console.log('⏰ Timezone: Asia/Dhaka (Bangladesh Standard Time)');
        
    } catch (error) {
        console.error('❌ Fatal error during startup:', error);
        process.exit(1);
    }
}

// Handle graceful shutdown
process.on('SIGINT', () => {
    console.log('\n👋 Shutting down Remo Bot...');
    process.exit(0);
});

process.on('SIGTERM', () => {
    console.log('\n🔻 Received termination signal');
    process.exit(0);
});

// Start the bot
startBot();

// Keep the process alive (Render Background Worker requirement)
setInterval(() => {
    // Just keep the process alive
}, 24 * 60 * 60 * 1000); // 24 hours