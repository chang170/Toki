/**
 * Local storage management for accounts and messages
 */
var Storage = {
    // Account
    getAccount: function() {
        var data = localStorage.getItem('messenger_account');
        return data ? JSON.parse(data) : null;
    },

    saveAccount: function(account) {
        localStorage.setItem('messenger_account', JSON.stringify(account));
    },

    deleteAccount: function() {
        localStorage.removeItem('messenger_account');
    },

    // Chats list
    getChats: function() {
        var data = localStorage.getItem('messenger_chats');
        return data ? JSON.parse(data) : [];
    },

    saveChats: function(chats) {
        localStorage.setItem('messenger_chats', JSON.stringify(chats));
    },

    addChat: function(chat) {
        var chats = this.getChats();
        // Don't duplicate
        if (!chats.some(function(c) { return c.roomCode === chat.roomCode; })) {
            chats.push(chat);
            this.saveChats(chats);
        }
        return chats;
    },

    // Messages per chat
    getMessages: function(roomCode) {
        var data = localStorage.getItem('messenger_msgs_' + roomCode);
        return data ? JSON.parse(data) : [];
    },

    saveMessage: function(roomCode, message) {
        var msgs = this.getMessages(roomCode);
        msgs.push(message);
        // Keep last 1000 messages per chat
        if (msgs.length > 1000) msgs = msgs.slice(-1000);
        localStorage.setItem('messenger_msgs_' + roomCode, JSON.stringify(msgs));
        return msgs;
    },

    // Export identity
    exportIdentity: function(password) {
        var account = this.getAccount();
        if (!account) return null;
        return JSON.stringify({
            type: 'messenger_identity',
            version: 1,
            account: account,
            exported: new Date().toISOString()
        });
    },

    // Import identity
    importIdentity: function(jsonStr, password) {
        try {
            var data = JSON.parse(jsonStr);
            if (data.type !== 'messenger_identity') return false;
            if (data.account.passwordHash !== CryptoUtil.hashPassword(password)) return false;
            this.saveAccount(data.account);
            return true;
        } catch (e) {
            return false;
        }
    }
};
