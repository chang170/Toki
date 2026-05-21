(function() {
    // App version - increment to force localStorage reset on all devices
    // App version - only increment for BREAKING changes that need localStorage reset
    var APP_VERSION = '3';
    var storedVersion = localStorage.getItem('messenger_version');
    if (storedVersion !== APP_VERSION) {
        var keys = Object.keys(localStorage).filter(function(k) { return k.startsWith('messenger_'); });
        keys.forEach(function(k) { localStorage.removeItem(k); });
        localStorage.setItem('messenger_version', APP_VERSION);
    }

    var currentRoom = null;
    var account = null;
    var unreadCounts = {};
    var processedMsgIds = {};

    // Check if already logged in
    account = Storage.getAccount();
    if (account) {
        showChatScreen();
    }

    // Auth handlers
    document.getElementById('loginBtn').addEventListener('click', function() {
        var username = document.getElementById('authUsername').value.trim();
        var password = document.getElementById('authPassword').value;
        if (!username || !password) { alert('Enter username and password.'); return; }

        var existing = Storage.getAccount();
        if (existing && existing.username === username && existing.passwordHash === CryptoUtil.hashPassword(password)) {
            account = existing;
            showChatScreen();
        } else if (existing) {
            alert('Incorrect password.');
        } else {
            alert('No account found. Click "Create Account" to make one.');
        }
    });

    document.getElementById('createBtn').addEventListener('click', function() {
        var username = document.getElementById('authUsername').value.trim();
        var password = document.getElementById('authPassword').value;
        if (!username || !password) { alert('Enter username and password.'); return; }
        if (password.length < 4) { alert('Password must be at least 4 characters.'); return; }

        var existing = Storage.getAccount();
        if (existing) {
            if (!confirm('An account already exists on this device. Replace it?')) return;
        }

        account = {
            username: username,
            passwordHash: CryptoUtil.hashPassword(password),
            peerId: CryptoUtil.generatePeerId(username),
            created: new Date().toISOString()
        };
        Storage.saveAccount(account);
        showChatScreen();
    });

    // Import identity
    document.getElementById('importBtn').addEventListener('click', function() {
        document.getElementById('importInput').click();
    });
    document.getElementById('importInput').addEventListener('change', function(e) {
        var file = e.target.files[0];
        if (!file) return;
        file.text().then(function(text) {
            var password = prompt('Enter the password for this identity:');
            if (!password) return;
            if (Storage.importIdentity(text, password)) {
                account = Storage.getAccount();
                showChatScreen();
            } else {
                alert('Import failed. Wrong password or invalid file.');
            }
        });
    });

    function showChatScreen() {
        document.getElementById('authScreen').classList.remove('active');
        document.getElementById('chatScreen').classList.add('active');

        // Set user info
        document.getElementById('myName').textContent = account.username;
        document.getElementById('myAvatar').textContent = account.username.charAt(0).toUpperCase();

        // Init peer connection
        PeerManager.init(account.peerId, account.username);
        PeerManager.onMessage = handleIncomingMessage;
        PeerManager.onPeerConnected = handlePeerConnected;
        PeerManager.onPeerDisconnected = handlePeerDisconnected;

        // Go online (Firebase presence)
        Presence.onUsersChanged = renderOnlineUsers;
        Presence.goOnline(account.peerId, account.username);

        renderChatList();
    }

    // New Chat Modal
    document.getElementById('newChatBtn').addEventListener('click', function() {
        document.getElementById('newChatModal').hidden = false;
    });
    document.getElementById('closeNewChat').addEventListener('click', function() {
        document.getElementById('newChatModal').hidden = true;
    });

    // Modal tabs
    document.querySelectorAll('.modal-tab').forEach(function(tab) {
        tab.addEventListener('click', function() {
            document.querySelectorAll('.modal-tab').forEach(function(t) { t.classList.remove('active'); });
            document.querySelectorAll('.modal-tab-content').forEach(function(c) { c.classList.remove('active'); });
            tab.classList.add('active');
            document.getElementById(tab.dataset.target).classList.add('active');
        });
    });

    // Create room
    document.getElementById('createRoomBtn').addEventListener('click', function() {
        var name = document.getElementById('newRoomName').value.trim() || 'Chat';
        var isGroup = document.getElementById('isGroupChat').checked;
        var code = CryptoUtil.generateRoomCode(account.peerId, name);

        var chat = {
            roomCode: code,
            name: name,
            isGroup: isGroup,
            created: new Date().toISOString(),
            createdBy: account.peerId
        };

        Storage.addChat(chat);
        renderChatList();

        document.getElementById('generatedCode').textContent = code;
        document.getElementById('roomCodeDisplay').hidden = false;
    });

    document.getElementById('copyCodeBtn').addEventListener('click', function() {
        var code = document.getElementById('generatedCode').textContent;
        navigator.clipboard.writeText(code).then(function() {
            document.getElementById('copyCodeBtn').textContent = 'Copied!';
            setTimeout(function() { document.getElementById('copyCodeBtn').textContent = 'Copy Code'; }, 2000);
        });
    });

    // Join room
    document.getElementById('joinRoomBtn').addEventListener('click', function() {
        var code = document.getElementById('joinRoomCode').value.trim();
        if (!code) { alert('Enter a group code.'); return; }

        var creatorPeerId = CryptoUtil.extractPeerId(code);
        var groupName = CryptoUtil.extractGroupName(code) || 'Group ' + code.split('.')[0];

        var chat = {
            roomCode: code,
            name: groupName,
            isGroup: true,
            joined: new Date().toISOString(),
            creatorPeerId: creatorPeerId
        };

        Storage.addChat(chat);
        renderChatList();
        document.getElementById('newChatModal').hidden = true;
        document.getElementById('joinRoomCode').value = '';
        selectChat(code);

        // Connect to the creator
        if (creatorPeerId) {
            PeerManager.connectToPeer(creatorPeerId, code);
        }
    });

    // Settings
    document.getElementById('settingsBtn').addEventListener('click', function() {
        document.getElementById('myPeerId').textContent = account.peerId;
        document.getElementById('settingsModal').hidden = false;
    });
    document.getElementById('closeSettings').addEventListener('click', function() {
        document.getElementById('settingsModal').hidden = true;
    });

    document.getElementById('exportIdentityBtn').addEventListener('click', function() {
        var json = Storage.exportIdentity();
        if (!json) return;
        var blob = new Blob([json], { type: 'application/json' });
        var url = URL.createObjectURL(blob);
        var a = document.createElement('a');
        a.href = url;
        a.download = account.username + '_identity.json';
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
    });

    document.getElementById('logoutBtn').addEventListener('click', function() {
        if (!confirm('Sign out? Your messages are saved locally.')) return;
        Presence.goOffline();
        PeerManager.destroy();
        document.getElementById('chatScreen').classList.remove('active');
        document.getElementById('authScreen').classList.add('active');
        document.getElementById('settingsModal').hidden = true;
        account = null;
    });

    // Online users
    function renderOnlineUsers(users) {
        var html = '';
        var count = 0;
        users.forEach(function(user) {
            if (user.peerId === account.peerId) return; // Skip self
            count++;
            html += '<div class="online-user" data-peer="' + escapeHtml(user.peerId) + '" data-name="' + escapeHtml(user.username) + '">' +
                '<span class="online-dot"></span>' +
                '<span class="online-user-name">' + escapeHtml(user.username) + '</span>' +
                '<span class="online-user-chat">Chat</span></div>';
        });
        document.getElementById('onlineList').innerHTML = html || '<p style="padding:0.5rem 1rem;font-size:0.8rem;color:#b2bec3;">No one else online</p>';
        document.getElementById('onlineCount').textContent = count;

        // Click to start direct chat
        document.querySelectorAll('.online-user').forEach(function(el) {
            el.addEventListener('click', function() {
                var peerId = el.dataset.peer;
                var name = el.dataset.name;
                startDirectChat(peerId, name);
            });
        });
    }

    function startDirectChat(peerId, name) {
        // Generate a deterministic room code from both peer IDs
        var ids = [account.peerId, peerId].sort();
        var roomCode = 'DM.' + ids[0] + '.' + ids[1];

        // Create or find existing direct chat with this user
        var chats = Storage.getChats();
        var existing = chats.find(function(c) { return c.roomCode === roomCode; });

        if (!existing) {
            var chat = {
                roomCode: roomCode,
                name: name,
                isGroup: false,
                created: new Date().toISOString(),
                createdBy: account.peerId,
                directPeer: peerId
            };
            Storage.addChat(chat);
            renderChatList();
        }

        selectChat(roomCode);

        // Only connect if not already connected
        if (PeerManager.getConnectedPeers(roomCode) === 0) {
            console.log('Connecting to peer:', peerId);
            PeerManager.connectToPeer(peerId, roomCode);
        }
    }

    // Chat list
    function renderChatList() {
        var chats = Storage.getChats();
        var html = '';
        chats.forEach(function(chat) {
            var msgs = Storage.getMessages(chat.roomCode);
            var lastMsg = msgs.length > 0 ? msgs[msgs.length - 1] : null;
            var lastText = lastMsg ? (lastMsg.media ? '📎 Media' : lastMsg.text) : 'No messages yet';
            var lastTime = lastMsg ? formatTime(lastMsg.timestamp) : '';
            var avatarClass = chat.isGroup ? 'chat-item-avatar group' : 'chat-item-avatar';
            var initial = chat.name.charAt(0).toUpperCase();
            var activeClass = currentRoom === chat.roomCode ? ' active' : '';

            html += '<div class="chat-item' + activeClass + '" data-room="' + chat.roomCode + '">';
            html += '<div class="' + avatarClass + '">' + initial + '</div>';
            html += '<div class="chat-item-info"><div class="chat-item-name">' + escapeHtml(chat.name) + '</div>';
            html += '<div class="chat-item-last">' + escapeHtml(lastText) + '</div></div>';
            var unread = unreadCounts[chat.roomCode] || 0;
            var unreadBadge = unread > 0 ? '<span class="unread-badge">' + unread + '</span>' : '';
            html += '<div class="chat-item-meta"><span class="chat-item-time">' + lastTime + '</span>' + unreadBadge + '</div>';
            html += '</div>';
        });

        document.getElementById('chatList').innerHTML = html || '<p style="padding:1rem;color:#636e72;text-align:center;font-size:0.85rem;">No groups yet. Click + to start.</p>';

        document.querySelectorAll('.chat-item').forEach(function(item) {
            item.addEventListener('click', function() {
                selectChat(item.dataset.room);
            });
        });
    }

    function selectChat(roomCode) {
        currentRoom = roomCode;
        // Clear unread for this chat
        delete unreadCounts[roomCode];
        updateTitleBadge();

        var chats = Storage.getChats();
        var chat = chats.find(function(c) { return c.roomCode === roomCode; });
        if (!chat) return;

        // Send read receipts for unread messages in this chat
        var msgs = Storage.getMessages(roomCode) || [];
        msgs.forEach(function(msg) {
            if (msg && msg.sender !== account.peerId && msg.msgId && !msg.readReceiptSent) {
                PeerManager.sendMessage(roomCode, {
                    type: 'receipt',
                    receiptType: 'read',
                    msgId: msg.msgId,
                    roomCode: roomCode,
                    sender: account.peerId
                });
            }
        });

        // Update header
        var peers = PeerManager.getConnectedPeers(roomCode);
        var isCreator = chat.createdBy === account.peerId;
        var deleteBtn = '';
        if (chat.isGroup && isCreator) {
            deleteBtn = ' <button id="deleteGroupBtn" style="background:#d63031;color:#fff;border:none;border-radius:4px;padding:0.3rem 0.6rem;font-size:0.75rem;cursor:pointer;margin-left:0.5rem;">Delete</button>';
        } else if (!chat.isGroup) {
            deleteBtn = ' <button id="deleteGroupBtn" style="background:#d63031;color:#fff;border:none;border-radius:4px;padding:0.3rem 0.6rem;font-size:0.75rem;cursor:pointer;margin-left:0.5rem;">Delete</button>';
        }
        var inviteBtn = chat.isGroup ? ' <button id="inviteBtn" style="background:#00b894;color:#fff;border:none;border-radius:4px;padding:0.3rem 0.6rem;font-size:0.75rem;cursor:pointer;margin-left:0.5rem;">Invite</button>' : '';

        document.getElementById('chatHeader').innerHTML =
            '<span class="chat-title">' + escapeHtml(chat.name) + ' <small style="color:#636e72;">(' + roomCode.split('.')[0] + ')</small>' + inviteBtn + deleteBtn + '</span>' +
            '<span class="chat-status">' + peers + ' connected</span>';

        // Delete handler
        if (document.getElementById('deleteGroupBtn')) {
            document.getElementById('deleteGroupBtn').addEventListener('click', function() {
                if (!confirm('Delete this chat? This cannot be undone.')) return;
                var chats = Storage.getChats().filter(function(c) { return c.roomCode !== roomCode; });
                Storage.saveChats(chats);
                localStorage.removeItem('messenger_msgs_' + roomCode);
                currentRoom = null;
                document.getElementById('chatHeader').innerHTML = '<span class="chat-title">Select or start a chat</span>';
                document.getElementById('messages').innerHTML = '';
                document.getElementById('messageInputArea').hidden = true;
                renderChatList();
            });
        }

        // Invite handler
        if (chat.isGroup && document.getElementById('inviteBtn')) {
            document.getElementById('inviteBtn').addEventListener('click', function() {
                var code = roomCode;
                if (navigator.clipboard) {
                    navigator.clipboard.writeText(code).then(function() {
                        alert('Group code copied!\n\nShare this with others to join:\n' + code);
                    });
                } else {
                    prompt('Share this group code with others:', code);
                }
            });
        }

        // Reconnect to peer if not connected
        if (PeerManager.getConnectedPeers(roomCode) === 0) {
            if (chat.directPeer) {
                console.log('Reconnecting to direct peer:', chat.directPeer);
                PeerManager.connectToPeer(chat.directPeer, roomCode);
            } else if (chat.creatorPeerId && chat.creatorPeerId !== account.peerId) {
                console.log('Reconnecting to group creator:', chat.creatorPeerId);
                PeerManager.connectToPeer(chat.creatorPeerId, roomCode);
            }
        }

        document.getElementById('messageInputArea').hidden = false;
        renderMessages(roomCode);
        renderChatList();
    }

    function renderMessages(roomCode) {
        var msgs = Storage.getMessages(roomCode);
        var html = '';
        msgs.forEach(function(msg) {
            var isMine = msg.sender === account.peerId;
            var cls = isMine ? 'msg msg-sent' : 'msg msg-received';
            html += '<div class="' + cls + '">';
            if (!isMine) html += '<div class="msg-sender">' + escapeHtml(msg.senderName || 'Unknown') + '</div>';
            if (msg.media) {
                if (msg.mediaType && msg.mediaType.startsWith('video')) {
                    html += '<div class="msg-media"><video src="' + msg.media + '" controls></video></div>';
                } else {
                    html += '<div class="msg-media"><img src="' + msg.media + '"></div>';
                }
            }
            if (msg.text) html += '<div>' + escapeHtml(msg.text) + '</div>';
            var checkMark = '';
            if (isMine) {
                if (msg.read) {
                    checkMark = '<span class="msg-check read">✓✓</span>';
                } else if (msg.delivered) {
                    checkMark = '<span class="msg-check delivered">✓✓</span>';
                } else {
                    checkMark = '<span class="msg-check sent">✓</span>';
                }
            }
            html += '<div class="msg-time">' + formatTime(msg.timestamp) + ' ' + checkMark + '</div>';
            html += '</div>';
        });

        var container = document.getElementById('messages');
        container.innerHTML = html || '<p style="text-align:center;color:#636e72;margin-top:2rem;">No messages yet. Say hello!</p>';
        container.scrollTop = container.scrollHeight;
    }

    // Send message
    document.getElementById('sendBtn').addEventListener('click', sendMessage);
    document.getElementById('messageText').addEventListener('keydown', function(e) {
        if (e.key === 'Enter') sendMessage();
    });

    function sendMessage() {
        var text = document.getElementById('messageText').value.trim();
        if (!text || !currentRoom) return;

        console.log('Sending message to room:', currentRoom, 'connections:', PeerManager.getConnectedPeers(currentRoom));

        var msg = {
            type: 'message',
            roomCode: currentRoom,
            sender: account.peerId,
            senderName: account.username,
            text: text,
            timestamp: Date.now(),
            msgId: Date.now() + '-' + Math.random().toString(36).substr(2, 5),
            delivered: false,
            read: false
        };

        Storage.saveMessage(currentRoom, msg);
        PeerManager.sendMessage(currentRoom, msg);
        renderMessages(currentRoom);
        renderChatList();
        document.getElementById('messageText').value = '';
    }

    // Attach media
    document.getElementById('attachBtn').addEventListener('click', function() {
        document.getElementById('attachInput').click();
    });
    document.getElementById('attachInput').addEventListener('change', function(e) {
        var file = e.target.files[0];
        if (!file || !currentRoom) return;

        if (file.type.startsWith('image/')) {
            // Compress image before sending
            compressImage(file, function(dataUrl) {
                sendMediaMessage(dataUrl, file.type);
            });
        } else if (file.type.startsWith('video/')) {
            // Videos: limit to 5MB
            if (file.size > 5 * 1024 * 1024) {
                alert('Video too large. Max 5MB.');
                e.target.value = '';
                return;
            }
            var reader = new FileReader();
            reader.onload = function(ev) {
                sendMediaMessage(ev.target.result, file.type);
            };
            reader.readAsDataURL(file);
        }
        e.target.value = '';
    });

    function compressImage(file, callback) {
        var img = new Image();
        img.onload = function() {
            var canvas = document.createElement('canvas');
            var maxSize = 800; // Max width/height
            var width = img.width;
            var height = img.height;

            if (width > maxSize || height > maxSize) {
                if (width > height) {
                    height = Math.round(height * maxSize / width);
                    width = maxSize;
                } else {
                    width = Math.round(width * maxSize / height);
                    height = maxSize;
                }
            }

            canvas.width = width;
            canvas.height = height;
            var ctx = canvas.getContext('2d');
            ctx.drawImage(img, 0, 0, width, height);
            var dataUrl = canvas.toDataURL('image/jpeg', 0.6);
            callback(dataUrl);
        };
        img.src = URL.createObjectURL(file);
    }

    function sendMediaMessage(dataUrl, mediaType) {
        var msg = {
            type: 'message',
            roomCode: currentRoom,
            sender: account.peerId,
            senderName: account.username,
            text: '',
            media: dataUrl,
            mediaType: mediaType,
            msgId: Date.now() + '-' + Math.random().toString(36).substr(2, 5),
            delivered: false,
            read: false,
            timestamp: Date.now()
        };

        Storage.saveMessage(currentRoom, msg);
        PeerManager.sendMessage(currentRoom, msg);
        renderMessages(currentRoom);
        renderChatList();
    }

    // Handle incoming messages
    // Unread message tracking

    function handleIncomingMessage(data) {
        if (data.type === 'message' && data.roomCode) {
            // Only process if it has content
            if (!data.sender || (!data.text && !data.media)) return;

            // Deduplicate - skip if we already processed this message
            if (data.msgId) {
                if (processedMsgIds[data.msgId]) return;
                processedMsgIds[data.msgId] = true;
            }

            Storage.saveMessage(data.roomCode, data);

            // Send delivery receipt
            if (data.msgId && data.sender !== account.peerId) {
                PeerManager.sendMessage(data.roomCode, {
                    type: 'receipt',
                    receiptType: 'delivered',
                    msgId: data.msgId,
                    roomCode: data.roomCode,
                    sender: account.peerId
                });
            }

            // Auto-add chat if we don't have it
            var chats = Storage.getChats();
            if (!chats.some(function(c) { return c.roomCode === data.roomCode; })) {
                var chatName = data.senderName || 'Chat';
                var isGroup = data.roomCode.indexOf('DM.') !== 0;
                Storage.addChat({
                    roomCode: data.roomCode,
                    name: chatName,
                    isGroup: isGroup,
                    directPeer: data.sender
                });
            }

            if (currentRoom === data.roomCode) {
                renderMessages(data.roomCode);
                // Send read receipt since chat is open
                if (data.msgId && data.sender !== account.peerId) {
                    PeerManager.sendMessage(data.roomCode, {
                        type: 'receipt',
                        receiptType: 'read',
                        msgId: data.msgId,
                        roomCode: data.roomCode,
                        sender: account.peerId
                    });
                }
            } else {
                // Mark as unread
                unreadCounts[data.roomCode] = (unreadCounts[data.roomCode] || 0) + 1;
            }

            // Update page title with total unread
            updateTitleBadge();
            renderChatList();
        } else if (data.type === 'receipt') {
            // Update message status
            var msgs = Storage.getMessages(data.roomCode);
            var updated = false;
            for (var i = 0; i < msgs.length; i++) {
                if (msgs[i].msgId === data.msgId) {
                    if (data.receiptType === 'delivered') {
                        msgs[i].delivered = true;
                    } else if (data.receiptType === 'read') {
                        msgs[i].delivered = true;
                        msgs[i].read = true;
                    }
                    updated = true;
                    break;
                }
            }
            if (updated) {
                localStorage.setItem('messenger_msgs_' + data.roomCode, JSON.stringify(msgs));
                if (currentRoom === data.roomCode) {
                    renderMessages(data.roomCode);
                }
            }
        }
    }

    function updateTitleBadge() {
        var total = 0;
        for (var room in unreadCounts) {
            total += unreadCounts[room];
        }
        document.title = total > 0 ? '(' + total + ') Toki' : 'Toki';
    }

    function handlePeerConnected(peerId, roomCode, name) {
        if (currentRoom === roomCode) {
            var peers = PeerManager.getConnectedPeers(roomCode);
            var chatStatus = document.querySelector('.chat-status');
            if (chatStatus) chatStatus.textContent = peers + ' connected';
        }
    }

    function handlePeerDisconnected(peerId) {
        if (currentRoom) {
            var peers = PeerManager.getConnectedPeers(currentRoom);
            var chatStatus = document.querySelector('.chat-status');
            if (chatStatus) chatStatus.textContent = peers + ' connected';
        }
    }

    // Utilities
    function formatTime(timestamp) {
        var d = new Date(timestamp);
        var now = new Date();
        var hours = d.getHours().toString().padStart(2, '0');
        var mins = d.getMinutes().toString().padStart(2, '0');
        if (d.toDateString() === now.toDateString()) {
            return hours + ':' + mins;
        }
        return (d.getMonth() + 1) + '/' + d.getDate() + ' ' + hours + ':' + mins;
    }

    function escapeHtml(str) {
        if (!str) return '';
        var div = document.createElement('div');
        div.textContent = str;
        return div.innerHTML;
    }

    // Clean up on page close
    window.addEventListener('beforeunload', function() {
        Presence.goOffline();
    });
})();
