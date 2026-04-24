require('dotenv').config();
const db = require('./database');

async function test() {
    console.log('--- Layer-D API Connection Test ---');
    const guildId = 'test-guild-123';
    const userId = 'test-user-456';

    try {
        console.log('1. Testing getGuildUsage...');
        const usage = await db.getGuildUsage(guildId);
        console.log('Result:', usage);

        console.log('\n2. Testing getUserSettings...');
        const settings = await db.getUserSettings(guildId, userId);
        console.log('Result:', settings);

        console.log('\n3. Testing addCharacterUsage...');
        await db.addCharacterUsage(guildId, 100);
        console.log('Success (implied)');

        console.log('\n4. Testing getGuildUsage again...');
        const usageAfter = await db.getGuildUsage(guildId);
        console.log('Result:', usageAfter);

        console.log('\n5. Testing getDictionaryEntries...');
        const dict = await db.getDictionaryEntries(guildId);
        console.log('Result:', dict);

        console.log('\n✅ Test Completed Successfully!');
    } catch (error) {
        console.error('\n❌ Test Failed:', error);
    }
}

test();
