(function() {
    // App version - increment to force localStorage reset on all devices
    // App version - only increment for BREAKING changes that need localStorage reset
    var APP_VERSION = '4';
    var storedVersion = localStorage.getItem('messenger_version');
    if (storedVersion !== APP_VERSION) {
        var keys = Object.keys(localStorage).filter(function(k) { return k.startsWith('messenger_'); });
        keys.forEach(function(k) { localStorage.removeItem(k); });
        localStorage.setItem('messenger_version', APP_VERSION);
    }

    // Prevent browser back button from leaving the app
    window.addEventListener('popstate', function(e) {
        history.pushState(null, '', location.href);
        if (window.innerWidth <= 768 && document.querySelector('.sidebar.hidden')) {
            document.querySelector('.sidebar').classList.remove('hidden');
            document.getElementById('messageInputArea').hidden = true;
            document.getElementById('navInputArea').style.display = '';
        }
    });
    history.pushState(null, '', location.href);
    history.pushState(null, '', location.href);

    // Warn before leaving
    window.addEventListener('beforeunload', function(e) {
        e.preventDefault();
        e.returnValue = '';
    });

    var currentRoom = null;
    var account = null;
    var unreadCounts = {};
    var processedMsgIds = {};
    var replyingTo = null;
    var openedGifts = {};
    var animationPlaying = false;

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

        // Check if username already exists in Firebase
        var xhr = new XMLHttpRequest();
        xhr.open('GET', Presence.dbUrl + '/presence.json', true);
        xhr.onload = function() {
            var nameTaken = false;
            if (xhr.status === 200) {
                var data = JSON.parse(xhr.responseText);
                if (data) {
                    for (var key in data) {
                        if (data[key].username && data[key].username.toLowerCase() === username.toLowerCase()) {
                            nameTaken = true;
                            break;
                        }
                    }
                }
            }

            if (nameTaken) {
                alert('A user with the name "' + username + '" already exists. Please choose a different name.');
                return;
            }

            account = {
                username: username,
                passwordHash: CryptoUtil.hashPassword(password),
                peerId: CryptoUtil.generatePeerId(username),
                created: new Date().toISOString()
            };
            Storage.saveAccount(account);
            showChatScreen();
        };
        xhr.send();
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

        // Request notification permission
        if ('Notification' in window && Notification.permission === 'default') {
            Notification.requestPermission();
        }

        // Set user info
        var profile = JSON.parse(localStorage.getItem('toki_profile') || '{}');
        var displayName = profile.nickname || profile.firstName || account.username;
        document.getElementById('myName').textContent = displayName;
        if (profile.picture) {
            document.getElementById('myAvatar').innerHTML = '<img src="' + profile.picture + '" style="width:100%;height:100%;object-fit:cover;border-radius:50%;">';
        } else {
            document.getElementById('myAvatar').textContent = displayName.charAt(0).toUpperCase();
        }

        // Init peer connection
        PeerManager.init(account.peerId, account.username);
        PeerManager.onMessage = handleIncomingMessage;
        PeerManager.onPeerConnected = handlePeerConnected;
        PeerManager.onPeerDisconnected = handlePeerDisconnected;

        // Go online (Firebase presence)
        Presence.onUsersChanged = renderOnlineUsers;
        Presence.goOnline(account.peerId, account.username);

        // Check for pending invites and actions
        Presence.checkInvites(account.peerId, function(items) {
            items.forEach(function(item) {
                if (item.type === 'invite') {
                    handleInvite(item);
                } else if (item.type === 'delete') {
                    // Handle offline delete
                    if (item.msgId && item.roomCode) {
                        var msgs = Storage.getMessages(item.roomCode);
                        for (var i = 0; i < msgs.length; i++) {
                            if (msgs[i].msgId === item.msgId) {
                                msgs[i].deleted = true;
                                msgs[i].text = '';
                                msgs[i].media = null;
                                msgs[i].location = null;
                                break;
                            }
                        }
                        localStorage.setItem('messenger_msgs_' + item.roomCode, JSON.stringify(msgs));
                    }
                } else if (item.type === 'deleteGroup') {
                    // Handle offline group deletion
                    if (item.roomCode) {
                        var chats = Storage.getChats().filter(function(c) { return c.roomCode !== item.roomCode; });
                        Storage.saveChats(chats);
                        localStorage.removeItem('messenger_msgs_' + item.roomCode);
                    }
                }
            });
            if (currentRoom) renderMessages(currentRoom);
            renderChatList();
        });

        renderChatList();
    }

    // Bottom nav (Chats / Calls)
    var callLog = JSON.parse(localStorage.getItem('toki_calllog') || '[]');

    document.querySelectorAll('.bottom-nav-btn').forEach(function(btn) {
        btn.addEventListener('click', function() {
            document.querySelectorAll('.bottom-nav-btn').forEach(function(b) { b.classList.remove('active'); });
            btn.classList.add('active');
            var view = btn.dataset.view;
            if (view === 'chats') {
                document.getElementById('chatList').style.display = '';
                document.getElementById('callHistory').style.display = 'none';
            } else {
                document.getElementById('chatList').style.display = 'none';
                document.getElementById('callHistory').style.display = '';
                renderCallHistory();
            }
        });
    });

    document.querySelectorAll('.nav-input-btn').forEach(function(btn) {
        btn.addEventListener('click', function() {
            document.querySelectorAll('.nav-input-btn').forEach(function(b) { b.classList.remove('active'); });
            btn.classList.add('active');
            var view = btn.dataset.view;
            if (view === 'chats') {
                document.getElementById('chatList').style.display = '';
                document.getElementById('callHistory').style.display = 'none';
            } else {
                document.getElementById('chatList').style.display = 'none';
                document.getElementById('callHistory').style.display = '';
                renderCallHistory();
            }
        });
    });

    function logCall(peerName, type, duration) {
        callLog.push({
            name: peerName,
            type: type, // 'outgoing', 'incoming', 'missed'
            time: Date.now(),
            duration: duration || 0
        });
        if (callLog.length > 50) callLog = callLog.slice(-50);
        localStorage.setItem('toki_calllog', JSON.stringify(callLog));
    }

    function renderCallHistory() {
        var html = '';
        if (callLog.length === 0) {
            html = '<p style="padding:1.5rem;text-align:center;color:#636e72;">No call history yet</p>';
        } else {
            var sorted = callLog.slice().reverse();
            sorted.forEach(function(call) {
                var icon, iconClass;
                if (call.type === 'missed') { icon = '📵'; iconClass = 'missed'; }
                else if (call.type === 'rejected') { icon = '🚫'; iconClass = 'missed'; }
                else if (call.type === 'outgoing') { icon = '📤'; iconClass = 'outgoing'; }
                else { icon = '📥'; iconClass = 'incoming'; }

                var timeStr = new Date(call.time).toLocaleString();
                var durStr = call.duration > 0 ? ' (' + Math.floor(call.duration / 60) + ':' + ('0' + (call.duration % 60)).slice(-2) + ')' : '';

                html += '<div class="call-item">' +
                    '<span class="call-item-icon ' + iconClass + '">' + icon + '</span>' +
                    '<div class="call-item-info"><div class="call-item-name">' + call.name + '</div>' +
                    '<div class="call-item-time">' + timeStr + durStr + '</div></div>' +
                    '<button class="call-item-action">📞</button></div>';
            });
        }
        document.getElementById('callHistory').innerHTML = html;
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
    document.getElementById('closeSettings').addEventListener('click', function() {
        document.getElementById('settingsModal').hidden = true;
    });

    // Profile
    var profile = JSON.parse(localStorage.getItem('toki_profile') || '{}');

    document.getElementById('uploadPicBtn').addEventListener('click', function() {
        document.getElementById('profilePicInput').click();
    });

    document.getElementById('profilePicInput').addEventListener('change', function(e) {
        var file = e.target.files[0];
        if (!file) return;
        // Compress and store
        var img = new Image();
        img.onload = function() {
            var canvas = document.createElement('canvas');
            var size = 100;
            canvas.width = size;
            canvas.height = size;
            var ctx = canvas.getContext('2d');
            ctx.drawImage(img, 0, 0, size, size);
            var dataUrl = canvas.toDataURL('image/jpeg', 0.7);
            profile.picture = dataUrl;
            localStorage.setItem('toki_profile', JSON.stringify(profile));
            renderProfilePic();
        };
        img.src = URL.createObjectURL(file);
    });

    document.getElementById('saveProfileBtn').addEventListener('click', function() {
        profile.firstName = document.getElementById('profileFirstName').value.trim();
        profile.lastName = document.getElementById('profileLastName').value.trim();
        profile.nickname = document.getElementById('profileNickname').value.trim();
        profile.showLastSeen = document.getElementById('profileShowLastSeen').checked;
        localStorage.setItem('toki_profile', JSON.stringify(profile));
        alert('Profile saved.');

        // Update display name in sidebar
        var displayName = profile.nickname || profile.firstName || account.username;
        document.getElementById('myName').textContent = displayName;
    });

    function loadProfileForm() {
        document.getElementById('profileFirstName').value = profile.firstName || '';
        document.getElementById('profileLastName').value = profile.lastName || '';
        document.getElementById('profileNickname').value = profile.nickname || '';
        document.getElementById('profileShowLastSeen').checked = profile.showLastSeen !== false;
        renderProfilePic();
    }

    function renderProfilePic() {
        var preview = document.getElementById('profilePicPreview');
        if (profile.picture) {
            preview.innerHTML = '<img src="' + profile.picture + '">';
        } else {
            preview.textContent = '👤';
        }
    }

    // Load profile when settings opened
    document.getElementById('settingsBtn').addEventListener('click', function() {
        document.getElementById('myPeerId').textContent = account.peerId;
        document.getElementById('settingsModal').hidden = false;
        loadProfileForm();
    });

    // Theme switching
    var savedTheme = localStorage.getItem('toki_theme') || 'default';
    applyTheme(savedTheme);

    document.querySelectorAll('.theme-btn').forEach(function(btn) {
        btn.addEventListener('click', function() {
            var theme = btn.dataset.theme;
            applyTheme(theme);
            localStorage.setItem('toki_theme', theme);
        });
    });

    function applyTheme(theme) {
        document.body.className = '';
        if (theme !== 'default') {
            document.body.classList.add('theme-' + theme);
        }
        document.querySelectorAll('.theme-btn').forEach(function(b) { b.classList.remove('active'); });
        var activeBtn = document.querySelector('.theme-btn[data-theme="' + theme + '"]');
        if (activeBtn) activeBtn.classList.add('active');
    }

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
        // Sort: online first, then offline by last seen
        users.sort(function(a, b) {
            if (a.online && !b.online) return -1;
            if (!a.online && b.online) return 1;
            return b.lastSeen - a.lastSeen;
        });
        users.forEach(function(user) {
            if (user.peerId === account.peerId) return; // Skip self
            if (user.online) count++;
            var avatar = user.picture ? '<img src="' + user.picture + '" style="width:100%;height:100%;object-fit:cover;border-radius:50%;">' : '';
            var dotClass = user.online ? 'online-dot' : 'online-dot offline-dot';
            var lastSeenText = '';
            if (!user.online && user.showLastSeen !== false) {
                lastSeenText = '<span class="last-seen-text"> &nbsp;-&nbsp; ' + formatLastSeen(user.lastSeen) + '</span>';
            }
            html += '<div class="online-user' + (user.online ? '' : ' offline') + '" data-peer="' + escapeHtml(user.peerId) + '" data-name="' + escapeHtml(user.username) + '">' +
                '<span class="' + dotClass + '"></span>' +
                (avatar ? '<span style="width:24px;height:24px;border-radius:50%;overflow:hidden;display:inline-block;">' + avatar + '</span>' : '') +
                '<span class="online-user-name">' + escapeHtml(user.username) + lastSeenText + '</span>' +
                (user.online ? '<span class="online-user-chat">Chat</span>' : '') + '</div>';
        });
        document.getElementById('onlineList').innerHTML = html || '<p style="padding:0.5rem 1rem;font-size:0.8rem;color:#b2bec3;">No one else online</p>';
        document.getElementById('onlineCount').textContent = count;

        // Cache profile pictures for chat list
        users.forEach(function(user) {
            if (user.peerId !== account.peerId && user.picture) {
                localStorage.setItem('toki_peerpic_' + user.peerId, user.picture);
            }
        });

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
            var lastText = lastMsg ? (lastMsg.media ? '📎 Media' : (lastMsg.location ? '📍 Location' : lastMsg.text)) : 'No messages yet';
            var lastTime = lastMsg ? formatTime(lastMsg.timestamp) : '';
            var avatarClass = chat.isGroup ? 'chat-item-avatar group' : 'chat-item-avatar';
            var initial = chat.name.charAt(0).toUpperCase();
            var activeClass = currentRoom === chat.roomCode ? ' active' : '';

            // Check if we have a cached profile pic for this peer
            var peerPic = chat.directPeer ? localStorage.getItem('toki_peerpic_' + chat.directPeer) : '';
            var avatarContent = peerPic ? '<img src="' + peerPic + '" style="width:100%;height:100%;object-fit:cover;border-radius:50%;">' : initial;

            html += '<div class="chat-item' + activeClass + '" data-room="' + chat.roomCode + '">';
            html += '<div class="' + avatarClass + '">' + avatarContent + '</div>';
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
            '<button class="back-btn" id="backBtn">←</button>' +
            '<span class="chat-title">' + escapeHtml(chat.name) + ' <small style="color:#636e72;">(' + roomCode.split('.')[0] + ')</small>' + inviteBtn + deleteBtn + '</span>' +
            '<button id="videoCallBtn" class="call-btn" title="Video Call">📹</button>' +
            '<button id="audioCallBtn" class="call-btn" title="Audio Call">📞</button>' +
            '<button id="chatMenuBtn" class="call-btn" title="More options">⋮</button>' +
            '<span class="chat-status">' + peers + ' connected</span>';

        // Delete handler
        if (document.getElementById('deleteGroupBtn')) {
            document.getElementById('deleteGroupBtn').addEventListener('click', function() {
                if (!confirm('Delete this chat? This cannot be undone.')) return;

                // Notify other members (online via P2P, offline via Firebase)
                var deleteGroupData = {
                    type: 'deleteGroup',
                    roomCode: roomCode,
                    sender: account.peerId,
                    senderName: account.username,
                    timestamp: Date.now()
                };
                PeerManager.sendMessage(roomCode, deleteGroupData);

                // Send to direct peer or group members via Firebase
                if (chat.directPeer) {
                    Presence.sendInvite(chat.directPeer, deleteGroupData);
                }

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
                showInviteModal(roomCode, chat.name);
            });
        }

        // Back button handler (mobile)
        if (document.getElementById('backBtn')) {
            document.getElementById('backBtn').addEventListener('click', function() {
                document.querySelector('.sidebar').classList.remove('hidden');
                document.getElementById('messageInputArea').hidden = true;
                document.getElementById('navInputArea').style.display = '';
            });
        }

        // Chat menu (three dots)
        if (document.getElementById('chatMenuBtn')) {
            document.getElementById('chatMenuBtn').addEventListener('click', function(e) {
                e.stopPropagation();
                showChatMenu(roomCode, chat);
            });
        }

        // Hide sidebar on mobile when chat is selected
        if (window.innerWidth <= 768) {
            document.querySelector('.sidebar').classList.add('hidden');
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
        document.getElementById('navInputArea').style.display = 'none';
        renderMessages(roomCode);
        renderChatList();
    }

    function renderMessages(roomCode) {
        var msgs = Storage.getMessages(roomCode);
        var html = '';
        msgs.forEach(function(msg, idx) {
            if (msg.deleted) {
                // Show deleted placeholder
                var isMine = msg.sender === account.peerId;
                var cls = isMine ? 'msg msg-sent msg-deleted' : 'msg msg-received msg-deleted';
                html += '<div class="' + cls + '"><em>🚫 This message was deleted</em></div>';
                return;
            }
            var isMine = msg.sender === account.peerId;
            var cls = isMine ? 'msg msg-sent' : 'msg msg-received';
            html += '<div class="' + cls + '" data-msg-idx="' + idx + '">';
            if (!isMine) html += '<div class="msg-sender">' + escapeHtml(msg.senderName || 'Unknown') + '</div>';
            if (msg.replyTo) {
                html += '<div class="msg-reply-quote">' +
                    '<span class="reply-name">' + escapeHtml(msg.replyTo.senderName || '') + '</span>' +
                    '<span class="reply-text">' + escapeHtml(msg.replyTo.text || '📎 Media') + '</span></div>';
            }
            if (msg.animation === 'giftbox') {
                var giftOpened = openedGifts[msg.msgId];
                if (giftOpened) {
                    html += '<div class="msg-giftbox opened">🎊</div>';
                } else {
                    html += '<div class="msg-giftbox" data-gift-id="' + msg.msgId + '" data-anim="giftbox">🎁<div class="giftbox-label">Tap to open!</div></div>';
                }
            } else if (msg.animation === 'basketball') {
                var bballOpened = openedGifts[msg.msgId];
                if (bballOpened) {
                    html += '<div class="msg-giftbox opened">🏀</div>';
                } else {
                    html += '<div class="msg-giftbox" data-gift-id="' + msg.msgId + '" data-anim="basketball">🏀<div class="giftbox-label">Tap to play!</div></div>';
                }
            } else if (msg.animation === 'redpacket') {
                var rpOpened = openedGifts[msg.msgId];
                if (rpOpened) {
                    html += '<div class="msg-giftbox opened">🧧💰</div>';
                } else {
                    html += '<div class="msg-giftbox" data-gift-id="' + msg.msgId + '" data-anim="redpacket">🧧<div class="giftbox-label">Tap to open!</div></div>';
                }
            } else if (msg.location) {
                var mapLink = 'https://www.google.com/maps?q=' + msg.location.lat + ',' + msg.location.lng;
                var mapImg = 'https://maps.googleapis.com/maps/api/staticmap?center=' + msg.location.lat + ',' + msg.location.lng + '&zoom=15&size=250x150&markers=color:red%7C' + msg.location.lat + ',' + msg.location.lng + '&key=';
                // Fallback to OpenStreetMap embed iframe
                var mapEmbed = '<iframe src="https://www.openstreetmap.org/export/embed.html?bbox=' +
                    (msg.location.lng - 0.005) + ',' + (msg.location.lat - 0.003) + ',' +
                    (msg.location.lng + 0.005) + ',' + (msg.location.lat + 0.003) +
                    '&layer=mapnik&marker=' + msg.location.lat + ',' + msg.location.lng +
                    '" style="width:250px;height:150px;border:none;border-radius:6px;"></iframe>';
                html += '<div class="msg-location">' +
                    '<a href="' + mapLink + '" target="_blank">' + mapEmbed + '</a>' +
                    '<a href="' + mapLink + '" target="_blank" style="color:#667eea;text-decoration:none;font-size:0.85rem;display:block;margin-top:0.3rem;">📍 ' + (msg.location.live ? 'Live location' : 'Open in Maps') + '</a></div>';
            } else if (msg.media) {
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
                    checkMark = '<span class="msg-check delivered">✓</span><span class="msg-check sent">✓</span>';
                } else if (msg.sent) {
                    checkMark = '<span class="msg-check sent">✓</span>';
                } else {
                    checkMark = '<span class="msg-check buffered">○</span>';
                }
            }
            html += '<div class="msg-time">' + formatTime(msg.timestamp) + ' ' + checkMark + '</div>';
            html += '</div>';
        });

        var container = document.getElementById('messages');
        container.innerHTML = html || '<p style="text-align:center;color:#636e72;margin-top:2rem;">No messages yet. Say hello!</p>';
        container.scrollTop = container.scrollHeight;
        setTimeout(function() { container.scrollTop = container.scrollHeight; }, 100);

        // Attach context menu for delete (double-click/double-tap)
        container.querySelectorAll('.msg[data-msg-idx]').forEach(function(el) {
            el.addEventListener('dblclick', function(e) {
                e.preventDefault();
                showDeleteMenu(e, parseInt(el.dataset.msgIdx));
            });
        });

        // Gift box click handler
        container.querySelectorAll('.msg-giftbox:not(.opened)').forEach(function(box) {
            box.addEventListener('click', function(e) {
                e.stopPropagation();
                if (animationPlaying) return;
                var giftId = box.dataset.giftId;
                var animType = box.dataset.anim;
                openedGifts[giftId] = true;
                box.classList.add('opened');
                animationPlaying = true;
                if (animType === 'basketball') {
                    box.innerHTML = '🏀';
                    showBasketballBounce(box);
                    setTimeout(function() { animationPlaying = false; }, 9000);
                } else if (animType === 'redpacket') {
                    box.innerHTML = '🧧💰';
                    showRedPacketRain(box);
                    setTimeout(function() { animationPlaying = false; }, 9000);
                } else {
                    box.innerHTML = '🎊';
                    showConfettiExplosion(box);
                    setTimeout(function() { animationPlaying = false; }, 8500);
                }
            });
        });
    }

    function showDeleteMenu(e, msgIdx) {
        // Remove existing menu
        var existing = document.getElementById('msgDeleteMenu');
        if (existing) existing.remove();

        var msgs = Storage.getMessages(currentRoom);
        var msg = msgs[msgIdx];
        if (!msg) return;

        var menu = document.createElement('div');
        menu.id = 'msgDeleteMenu';
        menu.className = 'msg-context-menu';
        menu.innerHTML =
            '<button class="ctx-btn" id="replyMsg">↩ Reply</button>' +
            '<button class="ctx-btn" id="deleteForMe">🗑 Delete for me</button>' +
            (msg.sender === account.peerId ? '<button class="ctx-btn ctx-danger" id="deleteForAll">🗑 Delete for everyone</button>' : '') +
            '<button class="ctx-btn" id="cancelDelete">Cancel</button>';

        menu.style.position = 'fixed';
        menu.style.left = '50%';
        menu.style.top = '50%';
        menu.style.transform = 'translate(-50%, -50%)';
        document.body.appendChild(menu);

        document.getElementById('replyMsg').addEventListener('click', function() {
            replyingTo = {
                msgId: msg.msgId,
                text: msg.text || (msg.media ? '📎 Media' : (msg.location ? '📍 Location' : '')),
                senderName: msg.senderName || 'Unknown'
            };
            showReplyPreview();
            document.getElementById('messageText').focus();
            menu.remove();
        });

        document.getElementById('deleteForMe').addEventListener('click', function() {
            deleteMessageForMe(msgIdx);
            menu.remove();
        });

        if (document.getElementById('deleteForAll')) {
            document.getElementById('deleteForAll').addEventListener('click', function() {
                deleteMessageForAll(msgIdx);
                menu.remove();
            });
        }

        document.getElementById('cancelDelete').addEventListener('click', function() {
            menu.remove();
        });

        // Close on click outside
        setTimeout(function() {
            document.addEventListener('click', function closeMenu() {
                menu.remove();
                document.removeEventListener('click', closeMenu);
            });
        }, 100);
    }

    function deleteMessageForMe(msgIdx) {
        var msgs = Storage.getMessages(currentRoom);
        msgs.splice(msgIdx, 1);
        localStorage.setItem('messenger_msgs_' + currentRoom, JSON.stringify(msgs));
        renderMessages(currentRoom);
    }

    function deleteMessageForAll(msgIdx) {
        var msgs = Storage.getMessages(currentRoom);
        var msg = msgs[msgIdx];
        if (!msg || !msg.msgId) return;

        // Mark as deleted locally
        msgs[msgIdx].deleted = true;
        msgs[msgIdx].text = '';
        msgs[msgIdx].media = null;
        msgs[msgIdx].location = null;
        localStorage.setItem('messenger_msgs_' + currentRoom, JSON.stringify(msgs));

        var deleteData = {
            type: 'delete',
            msgId: msg.msgId,
            roomCode: currentRoom,
            sender: account.peerId,
            timestamp: Date.now()
        };

        // Send delete signal to online peers
        PeerManager.sendMessage(currentRoom, deleteData);

        // Store in Firebase for offline peers
        var chats = Storage.getChats();
        var chat = chats.find(function(c) { return c.roomCode === currentRoom; });
        if (chat && chat.directPeer) {
            Presence.sendInvite(chat.directPeer, deleteData);
        }

        renderMessages(currentRoom);
    }

    // Chat settings menu
    function showChatMenu(roomCode, chat) {
        var existing = document.getElementById('chatSettingsMenu');
        if (existing) { existing.remove(); return; }

        var menu = document.createElement('div');
        menu.id = 'chatSettingsMenu';
        menu.className = 'msg-context-menu';
        menu.style.cssText = 'position:fixed;top:60px;right:20px;z-index:200;';
        menu.innerHTML =
            '<button class="ctx-btn" data-action="viewContact">👤 View Contact</button>' +
            '<button class="ctx-btn" data-action="searchChat">🔍 Search</button>' +
            '<button class="ctx-btn" data-action="mediaLinks">📁 Media, Links & Docs</button>' +
            '<button class="ctx-btn" data-action="muteNotif">🔇 Mute Notifications</button>' +
            '<button class="ctx-btn" data-action="disappearing">⏱ Disappearing Messages</button>' +
            '<button class="ctx-btn" data-action="block">🚫 Block</button>' +
            '<button class="ctx-btn" data-action="exportChat">📤 Export Chat</button>';

        document.body.appendChild(menu);

        menu.querySelectorAll('.ctx-btn').forEach(function(btn) {
            btn.addEventListener('click', function() {
                var action = btn.dataset.action;
                menu.remove();
                handleChatMenuAction(action, roomCode, chat);
            });
        });

        setTimeout(function() {
            document.addEventListener('click', function closeMenu(e) {
                if (menu.parentNode) menu.remove();
                document.removeEventListener('click', closeMenu);
            });
        }, 100);
    }

    function handleChatMenuAction(action, roomCode, chat) {
        var msgs = Storage.getMessages(roomCode);

        if (action === 'viewContact') {
            var info = 'Name: ' + chat.name + '\n';
            if (chat.directPeer) info += 'Peer ID: ' + chat.directPeer + '\n';
            if (chat.isGroup) info += 'Type: Group Chat\n';
            info += 'Created: ' + (chat.created || chat.joined || 'Unknown');
            alert(info);

        } else if (action === 'searchChat') {
            var term = prompt('Search messages:');
            if (!term) return;
            var results = msgs.filter(function(m) {
                return m.text && m.text.toLowerCase().indexOf(term.toLowerCase()) !== -1;
            });
            if (results.length === 0) {
                alert('No messages found containing "' + term + '"');
            } else {
                var display = results.slice(0, 10).map(function(m) {
                    return '[' + new Date(m.timestamp).toLocaleString() + '] ' + (m.senderName || '') + ': ' + m.text;
                }).join('\n\n');
                alert('Found ' + results.length + ' message(s):\n\n' + display);
            }

        } else if (action === 'mediaLinks') {
            var media = msgs.filter(function(m) { return m.media || (m.text && m.text.match(/https?:\/\//)); });
            if (media.length === 0) {
                alert('No media, links, or docs shared in this chat.');
            } else {
                var links = media.filter(function(m) { return m.text && m.text.match(/https?:\/\//); });
                var images = media.filter(function(m) { return m.media; });
                alert('Media: ' + images.length + ' image(s)/video(s)\nLinks: ' + links.length + ' link(s)');
            }

        } else if (action === 'muteNotif') {
            var muted = localStorage.getItem('toki_muted_' + roomCode);
            if (muted) {
                localStorage.removeItem('toki_muted_' + roomCode);
                alert('Notifications unmuted for this chat.');
            } else {
                localStorage.setItem('toki_muted_' + roomCode, 'true');
                alert('Notifications muted for this chat.');
            }

        } else if (action === 'disappearing') {
            var current = localStorage.getItem('toki_disappear_' + roomCode);
            var choice = prompt('Set disappearing messages duration:\n\nEnter minutes (0 = off):', current || '0');
            if (choice === null) return;
            var mins = parseInt(choice);
            if (mins > 0) {
                localStorage.setItem('toki_disappear_' + roomCode, String(mins));
                alert('Messages will disappear after ' + mins + ' minute(s).');
            } else {
                localStorage.removeItem('toki_disappear_' + roomCode);
                alert('Disappearing messages turned off.');
            }

        } else if (action === 'block') {
            if (!chat.directPeer) { alert('Can only block in direct messages.'); return; }
            var blocked = JSON.parse(localStorage.getItem('toki_blocked') || '[]');
            var isBlocked = blocked.indexOf(chat.directPeer) !== -1;
            if (isBlocked) {
                blocked = blocked.filter(function(p) { return p !== chat.directPeer; });
                localStorage.setItem('toki_blocked', JSON.stringify(blocked));
                alert(chat.name + ' has been unblocked.');
            } else {
                if (!confirm('Block ' + chat.name + '? You will not receive messages from them.')) return;
                blocked.push(chat.directPeer);
                localStorage.setItem('toki_blocked', JSON.stringify(blocked));
                alert(chat.name + ' has been blocked.');
            }

        } else if (action === 'exportChat') {
            var text = 'Chat Export: ' + chat.name + '\n';
            text += 'Exported: ' + new Date().toLocaleString() + '\n';
            text += '─'.repeat(40) + '\n\n';
            msgs.forEach(function(m) {
                if (m.deleted) return;
                var time = new Date(m.timestamp).toLocaleString();
                var sender = m.senderName || 'Unknown';
                var content = m.text || (m.media ? '[Media]' : (m.animation ? '[Animation]' : (m.location ? '[Location]' : '')));
                text += '[' + time + '] ' + sender + ': ' + content + '\n';
            });

            var blob = new Blob([text], { type: 'text/plain' });
            var url = URL.createObjectURL(blob);
            var a = document.createElement('a');
            a.href = url;
            a.download = 'chat_' + chat.name.replace(/[^a-zA-Z0-9]/g, '_') + '.txt';
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(url);
        }
    }

    // Group invite with user picker
    function showInviteModal(roomCode, groupName) {
        var existing = document.getElementById('inviteModal');
        if (existing) existing.remove();

        // Fetch all users from Firebase (online + offline)
        var xhr = new XMLHttpRequest();
        xhr.open('GET', Presence.dbUrl + '/presence.json', true);
        xhr.onload = function() {
            var allUsers = [];
            if (xhr.status === 200) {
                var data = JSON.parse(xhr.responseText);
                if (data) {
                    for (var key in data) {
                        var user = data[key];
                        if (user.peerId !== account.peerId) {
                            user.online = (Date.now() - user.lastSeen) < 30000;
                            allUsers.push(user);
                        }
                    }
                }
            }

            if (allUsers.length === 0) {
                alert('No other users found.');
                return;
            }

            // Sort: online first
            allUsers.sort(function(a, b) {
                if (a.online && !b.online) return -1;
                if (!a.online && b.online) return 1;
                return a.username.localeCompare(b.username);
            });

            var modal = document.createElement('div');
            modal.id = 'inviteModal';
            modal.className = 'modal';
            modal.innerHTML =
                '<div class="modal-content">' +
                '<h2>Invite to ' + escapeHtml(groupName) + '</h2>' +
                '<p style="font-size:0.85rem;color:#636e72;margin-bottom:1rem;">Select users to invite:</p>' +
                '<div id="inviteUserList" style="max-height:300px;overflow-y:auto;">' +
                allUsers.map(function(u) {
                    var statusDot = u.online ? '<span style="color:#00b894;">●</span>' : '<span style="color:#b2bec3;">●</span>';
                    var statusText = u.online ? '' : ' <span style="font-size:0.7rem;color:#b2bec3;">(offline)</span>';
                    return '<label style="display:flex;align-items:center;gap:0.5rem;padding:0.5rem 0;font-size:1rem;cursor:pointer;">' +
                        '<input type="checkbox" class="invite-check" data-peer="' + u.peerId + '" data-name="' + escapeHtml(u.username) + '"> ' +
                        statusDot + ' ' + escapeHtml(u.username) + statusText + '</label>';
                }).join('') +
                '</div>' +
                '<div style="margin-top:1rem;display:flex;gap:0.5rem;">' +
                '<button id="sendInviteBtn" style="flex:1;">Send Invite</button>' +
                '<button id="cancelInviteBtn" class="modal-close" style="position:static;font-size:1rem;padding:0.6rem 1.2rem;">Cancel</button>' +
                '</div></div>';

            document.body.appendChild(modal);

            document.getElementById('sendInviteBtn').addEventListener('click', function() {
                var selected = document.querySelectorAll('.invite-check:checked');
                if (selected.length === 0) { alert('Select at least one user.'); return; }

                var peers = [];
                selected.forEach(function(cb) { peers.push(cb.dataset.peer); });

                // Connect to all selected peers first
                peers.forEach(function(peerId) {
                    PeerManager.connectToPeer(peerId, 'invite-' + peerId);
                });

                // Send invites after connections establish
                setTimeout(function() {
                    peers.forEach(function(peerId) {
                        var inviteData = {
                            type: 'invite',
                            roomCode: roomCode,
                            groupName: groupName,
                            sender: account.peerId,
                            senderName: account.username,
                            invitedPeer: peerId,
                            timestamp: Date.now()
                        };
                        // Send through P2P connection (if online)
                        var conns = PeerManager.connections['invite-' + peerId] || [];
                        conns.forEach(function(conn) {
                            if (conn.open) conn.send(inviteData);
                        });
                        // Also store in Firebase (for offline delivery)
                        Presence.sendInvite(peerId, inviteData);
                    });
                }, 3000);

                modal.remove();
                alert('Invite sent to ' + selected.length + ' user(s). Offline users will receive it when they come online.');
            });

            document.getElementById('cancelInviteBtn').addEventListener('click', function() {
                modal.remove();
            });
        };
        xhr.send();
    }

    // Handle incoming invites
    var pendingInvites = [];

    function handleInvite(data) {
        // Show invite notification
        var notification = document.createElement('div');
        notification.className = 'invite-notification';
        notification.innerHTML =
            '<div class="invite-content">' +
            '<strong>' + escapeHtml(data.senderName) + '</strong> invited you to join<br>' +
            '<span style="color:#667eea;font-weight:700;">' + escapeHtml(data.groupName) + '</span>' +
            '</div>' +
            '<div class="invite-actions">' +
            '<button class="invite-accept">Accept</button>' +
            '<button class="invite-decline">Decline</button>' +
            '</div>';

        document.body.appendChild(notification);

        notification.querySelector('.invite-accept').addEventListener('click', function() {
            // Add group to chat list
            var chat = {
                roomCode: data.roomCode,
                name: data.groupName,
                isGroup: true,
                joined: new Date().toISOString(),
                creatorPeerId: data.sender
            };
            Storage.addChat(chat);
            renderChatList();
            selectChat(data.roomCode);

            // Connect to the inviter
            PeerManager.connectToPeer(data.sender, data.roomCode);
            notification.remove();
        });

        notification.querySelector('.invite-decline').addEventListener('click', function() {
            notification.remove();
        });

        // Auto-dismiss after 30 seconds
        setTimeout(function() {
            if (notification.parentNode) notification.remove();
        }, 30000);
    }

    // Send message
    document.getElementById('sendBtn').addEventListener('click', sendMessage);
    document.getElementById('messageText').addEventListener('keydown', function(e) {
        if (e.key === 'Enter') sendMessage();
    });

    var messageBuffer = {}; // roomCode -> [messages]

    function sendMessage() {
        var text = document.getElementById('messageText').value.trim();
        if (!text || !currentRoom) return;

        var msg = {
            type: 'message',
            roomCode: currentRoom,
            sender: account.peerId,
            senderName: account.username,
            text: text,
            timestamp: Date.now(),
            msgId: Date.now() + '-' + Math.random().toString(36).substr(2, 5),
            delivered: false,
            read: false,
            sent: false
        };

        // Include reply reference if replying
        if (replyingTo) {
            msg.replyTo = replyingTo;
            replyingTo = null;
            hideReplyPreview();
        }

        // Check if receiver is online via DOM (online users list)
        var receiverOnline = false;
        var chats = Storage.getChats();
        var chat = chats.find(function(c) { return c.roomCode === currentRoom; });
        if (chat && chat.directPeer) {
            var allUsers = document.querySelectorAll('.online-user');
            allUsers.forEach(function(el) {
                if (el.dataset.peer === chat.directPeer && !el.classList.contains('offline')) {
                    receiverOnline = true;
                }
            });
        } else {
            receiverOnline = PeerManager.getConnectedPeers(currentRoom) > 0;
        }

        if (receiverOnline) {
            msg.sent = true;
            // Try existing connection first
            var sent = PeerManager.sendMessage(currentRoom, msg);
            if (!sent && chat && chat.directPeer) {
                // Connection dead, reconnect and send
                var conn = PeerManager.peer.connect(chat.directPeer, { reliable: true });
                conn.on('open', function() {
                    if (!PeerManager.connections[currentRoom]) PeerManager.connections[currentRoom] = [];
                    PeerManager.connections[currentRoom].push(conn);
                    conn.send(msg);
                });
            }
        } else {
            // Buffer the message
            if (!messageBuffer[currentRoom]) messageBuffer[currentRoom] = [];
            messageBuffer[currentRoom].push(msg);
        }

        Storage.saveMessage(currentRoom, msg);
        renderMessages(currentRoom);
        renderChatList();
        document.getElementById('messageText').value = '';
    }

    // Monitor for peer coming online and flush buffer
    setInterval(function() {
        for (var room in messageBuffer) {
            if (messageBuffer[room].length > 0) {
                // Check if receiver is online via DOM
                var chats = Storage.getChats();
                var chat = chats.find(function(c) { return c.roomCode === room; });
                var receiverOnline = false;

                if (chat && chat.directPeer) {
                    var allUsers = document.querySelectorAll('.online-user');
                    allUsers.forEach(function(el) {
                        if (el.dataset.peer === chat.directPeer && !el.classList.contains('offline')) {
                            receiverOnline = true;
                        }
                    });
                }

                if (!receiverOnline) continue;

                // Receiver is online - connect and send
                if (chat && chat.directPeer) {
                    (function(r, peer) {
                        var conn = PeerManager.peer.connect(peer, { reliable: true });
                        conn.on('open', function() {
                            if (!PeerManager.connections[r]) PeerManager.connections[r] = [];
                            PeerManager.connections[r].push(conn);

                            conn.on('data', function(data) {
                                PeerManager.handleData(conn, data);
                            });

                            // Flush buffer
                            var toSend = messageBuffer[r].slice();
                            messageBuffer[r] = [];
                            toSend.forEach(function(msg) {
                                msg.sent = true;
                                conn.send(msg);
                                var stored = Storage.getMessages(r);
                                for (var i = 0; i < stored.length; i++) {
                                    if (stored[i].msgId === msg.msgId) {
                                        stored[i].sent = true;
                                        break;
                                    }
                                }
                                localStorage.setItem('messenger_msgs_' + r, JSON.stringify(stored));
                            });
                            if (currentRoom === r) renderMessages(r);
                        });
                        conn.on('error', function() {
                            // Connection failed, will retry next cycle
                        });
                    })(room, chat.directPeer);
                }
            }
        }
    }, 5000);

    function showReplyPreview() {
        var existing = document.getElementById('replyPreview');
        if (existing) existing.remove();

        var preview = document.createElement('div');
        preview.id = 'replyPreview';
        preview.className = 'reply-preview';
        preview.innerHTML = '<div class="reply-preview-content">' +
            '<span class="reply-preview-name">' + escapeHtml(replyingTo.senderName) + '</span>' +
            '<span class="reply-preview-text">' + escapeHtml(replyingTo.text) + '</span></div>' +
            '<button id="cancelReply" class="reply-cancel">&times;</button>';

        var inputArea = document.getElementById('messageInputArea');
        inputArea.parentNode.insertBefore(preview, inputArea);

        document.getElementById('cancelReply').addEventListener('click', function() {
            replyingTo = null;
            hideReplyPreview();
        });
    }

    function hideReplyPreview() {
        var existing = document.getElementById('replyPreview');
        if (existing) existing.remove();
    }    // Attach media
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

    // Location sharing
    var liveLocationInterval = null;
    var liveLocationActive = false;

    document.getElementById('locationBtn').addEventListener('click', function() {
        if (liveLocationActive) {
            stopLiveLocation();
        } else {
            showLocationMenu();
        }
    });

    function showLocationMenu() {
        var choice = confirm('Share live location?\n\nOK = Live location (updates while tab is open)\nCancel = Send current location once');
        if (choice) {
            startLiveLocation();
        } else {
            sendCurrentLocation();
        }
    }

    function sendCurrentLocation() {
        if (!navigator.geolocation) { alert('Geolocation not supported.'); return; }
        navigator.geolocation.getCurrentPosition(function(pos) {
            var lat = pos.coords.latitude;
            var lng = pos.coords.longitude;
            var mapUrl = 'https://www.google.com/maps?q=' + lat + ',' + lng;
            var msg = {
                type: 'message',
                roomCode: currentRoom,
                sender: account.peerId,
                senderName: account.username,
                text: '📍 Location: ' + lat.toFixed(6) + ', ' + lng.toFixed(6) + '\n' + mapUrl,
                location: { lat: lat, lng: lng },
                msgId: Date.now() + '-' + Math.random().toString(36).substr(2, 5),
                delivered: false,
                read: false,
                timestamp: Date.now()
            };
            Storage.saveMessage(currentRoom, msg);
            PeerManager.sendMessage(currentRoom, msg);
            renderMessages(currentRoom);
            renderChatList();
        }, function(err) {
            alert('Could not get location: ' + err.message);
        }, { enableHighAccuracy: true });
    }

    function startLiveLocation() {
        if (!navigator.geolocation) { alert('Geolocation not supported.'); return; }
        liveLocationActive = true;
        document.getElementById('locationBtn').textContent = '📍✕';
        document.getElementById('locationBtn').title = 'Stop live location';

        // Send immediately
        sendLocationUpdate();

        // Update every 10 seconds
        liveLocationInterval = setInterval(function() {
            if (!document.hidden) {
                sendLocationUpdate();
            }
        }, 10000);
    }

    function stopLiveLocation() {
        liveLocationActive = false;
        liveLocationMsgId = null;
        if (liveLocationInterval) {
            clearInterval(liveLocationInterval);
            liveLocationInterval = null;
        }
        document.getElementById('locationBtn').textContent = '📍';
        document.getElementById('locationBtn').title = 'Share location';

        // Send stop message
        if (currentRoom) {
            var msg = {
                type: 'message',
                roomCode: currentRoom,
                sender: account.peerId,
                senderName: account.username,
                text: '📍 Live location ended',
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
    }

    var liveLocationMsgId = null;

    function sendLocationUpdate() {
        if (!currentRoom || !liveLocationActive) return;
        navigator.geolocation.getCurrentPosition(function(pos) {
            var lat = pos.coords.latitude;
            var lng = pos.coords.longitude;
            var mapUrl = 'https://www.google.com/maps?q=' + lat + ',' + lng;

            // Use same msgId to update existing message
            if (!liveLocationMsgId) {
                liveLocationMsgId = 'live-' + Date.now() + '-' + Math.random().toString(36).substr(2, 5);
            }

            var msg = {
                type: 'message',
                roomCode: currentRoom,
                sender: account.peerId,
                senderName: account.username,
                text: '📍 Live location: ' + lat.toFixed(6) + ', ' + lng.toFixed(6) + '\n' + mapUrl,
                location: { lat: lat, lng: lng, live: true },
                msgId: liveLocationMsgId,
                isLiveLocationUpdate: true,
                delivered: false,
                read: false,
                timestamp: Date.now()
            };

            // Update existing message in storage instead of adding new one
            var msgs = Storage.getMessages(currentRoom);
            var existingIdx = -1;
            for (var i = 0; i < msgs.length; i++) {
                if (msgs[i].msgId === liveLocationMsgId) {
                    existingIdx = i;
                    break;
                }
            }
            if (existingIdx >= 0) {
                msgs[existingIdx] = msg;
                localStorage.setItem('messenger_msgs_' + currentRoom, JSON.stringify(msgs));
            } else {
                Storage.saveMessage(currentRoom, msg);
            }

            PeerManager.sendMessage(currentRoom, msg);
            renderMessages(currentRoom);
        }, function() {}, { enableHighAccuracy: true });
    }

    // Resume live location when tab becomes visible
    document.addEventListener('visibilitychange', function() {
        if (!document.hidden && liveLocationActive) {
            sendLocationUpdate();
        }
    });

    // Emoji picker
    var emojis = ['😊','😂','❤️','👍','👎','🙏','🔥','🎉','😢','😮','😡','🤔','👋','💯','✅','❌','⭐','🙌','💪','😎','🥳','😍','🤣','😭','😱','🤝','👏','💀','🫡','😴'];

    // Send Animation (Gift selection)
    document.getElementById('animBtn').addEventListener('click', function() {
        if (!currentRoom) return;
        var existing = document.getElementById('animPicker');
        if (existing) { existing.remove(); return; }

        var picker = document.createElement('div');
        picker.id = 'animPicker';
        picker.className = 'emoji-picker';
        picker.innerHTML =
            '<span class="emoji-item anim-choice" data-anim="giftbox" title="Gift Box Explosion">🎁</span>' +
            '<span class="emoji-item anim-choice" data-anim="basketball" title="Basketball Bounce">🏀</span>' +
            '<span class="emoji-item anim-choice" data-anim="redpacket" title="Red Packet Money Rain">🧧</span>';

        var inputArea = document.getElementById('messageInputArea');
        inputArea.insertBefore(picker, inputArea.firstChild);

        picker.querySelectorAll('.anim-choice').forEach(function(item) {
            item.addEventListener('click', function() {
                var animType = item.dataset.anim;
                var msg = {
                    type: 'message',
                    roomCode: currentRoom,
                    sender: account.peerId,
                    senderName: account.username,
                    text: '',
                    animation: animType,
                    msgId: Date.now() + '-' + Math.random().toString(36).substr(2, 5),
                    delivered: false,
                    read: false,
                    timestamp: Date.now()
                };
                if (replyingTo) {
                    msg.replyTo = replyingTo;
                    replyingTo = null;
                    hideReplyPreview();
                }
                Storage.saveMessage(currentRoom, msg);
                PeerManager.sendMessage(currentRoom, msg);
                renderMessages(currentRoom);
                renderChatList();
                picker.remove();
            });
        });

        setTimeout(function() {
            document.addEventListener('click', function closePicker(e) {
                if (!picker.contains(e.target) && e.target.id !== 'animBtn') {
                    picker.remove();
                    document.removeEventListener('click', closePicker);
                }
            });
        }, 100);
    });

    function playExplosionSound() {
        try {
            var ctx = new (window.AudioContext || window.webkitAudioContext)();
            for (var i = 0; i < 5; i++) {
                (function(delay) {
                    setTimeout(function() {
                        var osc = ctx.createOscillator();
                        var gain = ctx.createGain();
                        osc.connect(gain);
                        gain.connect(ctx.destination);
                        osc.frequency.value = 200 + Math.random() * 400;
                        osc.type = 'square';
                        gain.gain.setValueAtTime(0.3, ctx.currentTime);
                        gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.15);
                        osc.start(ctx.currentTime);
                        osc.stop(ctx.currentTime + 0.15);
                    }, delay);
                })(i * 150 + Math.random() * 100);
            }
        } catch(e) {}
    }

    function playBounceSound() {
        try {
            var ctx = new (window.AudioContext || window.webkitAudioContext)();
            var osc = ctx.createOscillator();
            var gain = ctx.createGain();
            osc.connect(gain);
            gain.connect(ctx.destination);
            osc.frequency.value = 80 + Math.random() * 60;
            osc.type = 'sine';
            gain.gain.setValueAtTime(0.4, ctx.currentTime);
            gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.2);
            osc.start(ctx.currentTime);
            osc.stop(ctx.currentTime + 0.2);
        } catch(e) {}
    }

    function showBasketballBounce(element) {
        var container = document.createElement('div');
        container.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:9999;overflow:hidden;';
        document.body.appendChild(container);

        var screenW = window.innerWidth;
        var screenH = window.innerHeight;

        for (var i = 0; i < 28; i++) {
            (function(idx) {
                var ball = document.createElement('div');
                ball.style.cssText = 'position:absolute;font-size:4rem;' +
                    'left:' + (Math.random() * (screenW - 60)) + 'px;top:-60px;';
                ball.textContent = '🏀';
                container.appendChild(ball);

                var x = parseFloat(ball.style.left);
                var y = -60;
                var vx = (Math.random() - 0.5) * 6;
                var vy = 0;
                var gravity = 0.5;
                var bounce = 0.75;
                var frame = 0;
                var maxFrames = 480; // ~8 seconds at 60fps

                function animate() {
                    vy += gravity;
                    x += vx;
                    y += vy;

                    if (y > screenH - 60) {
                        y = screenH - 60;
                        vy = -vy * bounce;
                        playBounceSound();
                    }
                    if (x < 0 || x > screenW - 60) {
                        vx = -vx;
                        x = Math.max(0, Math.min(x, screenW - 60));
                    }

                    ball.style.left = x + 'px';
                    ball.style.top = y + 'px';
                    ball.style.transform = 'rotate(' + (frame * 5) + 'deg)';

                    frame++;
                    if (frame < maxFrames) {
                        requestAnimationFrame(animate);
                    }
                }

                setTimeout(function() {
                    animate();
                }, idx * 200);
            })(i);
        }

        setTimeout(function() { container.remove(); }, 9000);
    }

    function playCasinoSound() {
        try {
            var ctx = new (window.AudioContext || window.webkitAudioContext)();
            // Lottery winner fanfare - dramatic ascending with sustained celebration
            var fanfare = [
                {f: 392, t: 0, d: 0.3},
                {f: 494, t: 0.15, d: 0.3},
                {f: 587, t: 0.3, d: 0.3},
                {f: 784, t: 0.45, d: 0.5},
                {f: 988, t: 0.7, d: 0.6},
                {f: 1175, t: 1.0, d: 0.8},
                {f: 1568, t: 1.3, d: 1.0},
            ];
            fanfare.forEach(function(note) {
                setTimeout(function() {
                    var osc = ctx.createOscillator();
                    var gain = ctx.createGain();
                    osc.connect(gain);
                    gain.connect(ctx.destination);
                    osc.frequency.value = note.f;
                    osc.type = 'triangle';
                    gain.gain.setValueAtTime(0.25, ctx.currentTime);
                    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + note.d);
                    osc.start(ctx.currentTime);
                    osc.stop(ctx.currentTime + note.d);
                }, note.t * 1000);
            });
            // Celebration shimmer
            setTimeout(function() {
                for (var i = 0; i < 15; i++) {
                    (function(delay) {
                        setTimeout(function() {
                            var osc = ctx.createOscillator();
                            var gain = ctx.createGain();
                            osc.connect(gain);
                            gain.connect(ctx.destination);
                            osc.frequency.value = 1000 + Math.random() * 2000;
                            osc.type = 'sine';
                            gain.gain.setValueAtTime(0.1, ctx.currentTime);
                            gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.15);
                            osc.start(ctx.currentTime);
                            osc.stop(ctx.currentTime + 0.15);
                        }, delay);
                    })(i * 200 + Math.random() * 100);
                }
            }, 2000);
            // Final big chord
            setTimeout(function() {
                [523, 659, 784, 1047].forEach(function(freq) {
                    var osc = ctx.createOscillator();
                    var gain = ctx.createGain();
                    osc.connect(gain);
                    gain.connect(ctx.destination);
                    osc.frequency.value = freq;
                    osc.type = 'triangle';
                    gain.gain.setValueAtTime(0.2, ctx.currentTime);
                    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 1.5);
                    osc.start(ctx.currentTime);
                    osc.stop(ctx.currentTime + 1.5);
                });
            }, 5000);
        } catch(e) {}
    }

    function showRedPacketRain(element) {
        playCasinoSound();
        var container = document.createElement('div');
        container.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:9999;overflow:hidden;';
        document.body.appendChild(container);

        var screenW = window.innerWidth;
        var items = [];
        // 10 gold coins, 10 bitcoins, 10 ethereum, 20 dollar bills
        for (var i = 0; i < 10; i++) items.push('🪙');
        for (var i = 0; i < 10; i++) items.push('₿');
        for (var i = 0; i < 10; i++) items.push('⟠');
        for (var i = 0; i < 20; i++) items.push('💵');

        // Drop items continuously over 8 seconds
        items.forEach(function(emoji, idx) {
            (function(em, delay) {
                setTimeout(function() {
                    var item = document.createElement('div');
                    var x = Math.random() * (screenW - 40);
                    var duration = 2 + Math.random() * 2;
                    var isCrypto = (em === '₿' || em === '⟠');

                    item.style.cssText = 'position:absolute;font-size:' + (isCrypto ? '2.5rem' : '3rem') + ';' +
                        'left:' + x + 'px;top:-50px;' +
                        'transition:all ' + duration + 's linear;opacity:1;';
                    if (isCrypto) {
                        item.style.cssText += 'background:#f7931a;color:#fff;width:40px;height:40px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:1.5rem;font-weight:900;';
                        if (em === '⟠') item.style.background = '#627eea';
                    }
                    item.textContent = em;
                    container.appendChild(item);

                    setTimeout(function() {
                        item.style.top = (window.innerHeight + 50) + 'px';
                        item.style.transform = 'rotate(' + (Math.random() * 360) + 'deg)';
                    }, 30);

                    setTimeout(function() { item.remove(); }, duration * 1000 + 100);
                }, delay);
            })(emoji, idx * 160 + Math.random() * 100);
        });

        setTimeout(function() { container.remove(); }, 9000);
    }

    function showConfettiExplosion(element) {
        playExplosionSound();
        var colors = ['#ff0000','#ffd700','#00ff00','#00bfff','#ff69b4','#ff8c00','#9400d3','#ff4500','#7fff00','#dc143c'];
        var container = document.createElement('div');
        container.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:9999;overflow:hidden;';
        document.body.appendChild(container);

        var cx = window.innerWidth / 2;
        var cy = window.innerHeight / 2;

        // Multiple waves of particles
        for (var wave = 0; wave < 6; wave++) {
            (function(w) {
                setTimeout(function() {
                    for (var i = 0; i < 50; i++) {
                        var particle = document.createElement('div');
                        var color = colors[Math.floor(Math.random() * colors.length)];
                        var size = 8 + Math.random() * 14;
                        var angle = Math.random() * Math.PI * 2;
                        var velocity = 200 + Math.random() * 500;
                        var dx = Math.cos(angle) * velocity;
                        var dy = Math.sin(angle) * velocity;
                        var shape = Math.random() > 0.5 ? '50%' : '0';

                        particle.style.cssText = 'position:absolute;width:' + size + 'px;height:' + size + 'px;' +
                            'background:' + color + ';border-radius:' + shape + ';' +
                            'left:' + cx + 'px;top:' + cy + 'px;' +
                            'transition:all 2.5s cubic-bezier(0.25,0.46,0.45,0.94);opacity:1;';
                        container.appendChild(particle);

                        setTimeout(function(p, x, y) {
                            return function() {
                                p.style.left = (cx + x) + 'px';
                                p.style.top = (cy + y + 300) + 'px';
                                p.style.opacity = '0';
                                p.style.transform = 'rotate(' + (Math.random() * 1080) + 'deg) scale(0.3)';
                            };
                        }(particle, dx, dy), 20);
                    }
                    if (w > 0) playExplosionSound();
                }, w * 600);
            })(wave);
        }

        // Add sparkle emojis across the screen
        var sparkles = ['✨','🎆','🎇','💥','🌟','🎉','🎊','⭐'];
        for (var j = 0; j < 20; j++) {
            (function(delay) {
                setTimeout(function() {
                    var spark = document.createElement('div');
                    var sx = Math.random() * window.innerWidth;
                    var sy = Math.random() * window.innerHeight;
                    spark.style.cssText = 'position:absolute;font-size:3rem;' +
                        'left:' + sx + 'px;top:' + sy + 'px;' +
                        'transition:all 1.5s ease-out;opacity:1;transform:scale(0);';
                    spark.textContent = sparkles[Math.floor(Math.random() * sparkles.length)];
                    container.appendChild(spark);

                    setTimeout(function() {
                        spark.style.transform = 'scale(1.5)';
                        spark.style.opacity = '0';
                    }, 50);
                }, delay);
            })(Math.random() * 6000);
        }

        setTimeout(function() { container.remove(); }, 8500);
    }

    document.getElementById('emojiBtn').addEventListener('click', function() {
        var existing = document.getElementById('emojiPicker');
        if (existing) { existing.remove(); return; }

        var picker = document.createElement('div');
        picker.id = 'emojiPicker';
        picker.className = 'emoji-picker';
        picker.innerHTML = emojis.map(function(e) {
            return '<span class="emoji-item">' + e + '</span>';
        }).join('');

        var inputArea = document.getElementById('messageInputArea');
        inputArea.insertBefore(picker, inputArea.firstChild);

        picker.querySelectorAll('.emoji-item').forEach(function(item) {
            item.addEventListener('click', function() {
                var input = document.getElementById('messageText');
                input.value += item.textContent;
                input.focus();
            });
        });

        picker.scrollIntoView({ behavior: 'smooth', block: 'nearest' });

        // Close picker when clicking outside
        setTimeout(function() {
            document.addEventListener('click', function closePicker(e) {
                if (!picker.contains(e.target) && e.target.id !== 'emojiBtn') {
                    picker.remove();
                    document.removeEventListener('click', closePicker);
                }
            });
        }, 100);
    });

    // Video/Audio Call
    var localStream = null;
    var currentCall = null;
    var micEnabled = true;
    var camEnabled = true;

    // Call button handlers (attached via event delegation on chat header)
    document.querySelector('.chat-area').addEventListener('click', function(e) {
        if (e.target.id === 'videoCallBtn') {
            startCall(true);
        } else if (e.target.id === 'audioCallBtn') {
            startCall(false);
        }
    });

    var callStartTime = null;

    function startCall(withVideo) {
        if (!currentRoom) return;
        var chats = Storage.getChats();
        var chat = chats.find(function(c) { return c.roomCode === currentRoom; });
        if (!chat) return;

        callStartTime = Date.now();
        logCall(chat.name, 'outgoing', 0);

        var constraints = { audio: true, video: withVideo };
        navigator.mediaDevices.getUserMedia(constraints).then(function(stream) {
            localStream = stream;
            document.getElementById('localVideo').srcObject = stream;
            document.getElementById('callScreen').classList.add('active');
            document.getElementById('callInfo').textContent = 'Calling ' + chat.name + '...';

            if (!withVideo) {
                document.getElementById('localVideo').style.display = 'none';
                document.getElementById('remoteVideo').style.display = 'none';
            }

            // Call all connected peers in this room
            var conns = PeerManager.connections[currentRoom] || [];
            conns.forEach(function(conn) {
                if (conn.open) {
                    var call = PeerManager.peer.call(conn.peer, stream);
                    currentCall = call;
                    call.on('stream', function(remoteStream) {
                        document.getElementById('remoteVideo').srcObject = remoteStream;
                        document.getElementById('callInfo').textContent = chat.name;
                    });
                    call.on('close', function() {
                        endCall();
                    });
                }
            });

            // Also try direct peer for DMs
            if (chat.directPeer && conns.length === 0) {
                var call = PeerManager.peer.call(chat.directPeer, stream);
                currentCall = call;
                call.on('stream', function(remoteStream) {
                    document.getElementById('remoteVideo').srcObject = remoteStream;
                    document.getElementById('callInfo').textContent = chat.name;
                });
                call.on('close', function() {
                    endCall();
                });
            }

            // Notify peers about incoming call
            PeerManager.sendMessage(currentRoom, {
                type: 'callSignal',
                callType: withVideo ? 'video' : 'audio',
                sender: account.peerId,
                senderName: account.username,
                roomCode: currentRoom
            });

        }).catch(function(err) {
            alert('Could not access camera/microphone: ' + err.message);
        });
    }

    // Handle incoming calls via PeerManager callback
    PeerManager.onIncomingCall = function(call) {
        var callerName = call.peer;
        document.getElementById('incomingCall').hidden = false;
        document.getElementById('incomingCaller').textContent = callerName;
        document.getElementById('incomingType').textContent = 'Incoming call...';

        // Auto-log as missed (will update if answered)
        var missedIdx = callLog.length;
        logCall(callerName, 'missed', 0);

        document.getElementById('acceptCallBtn').onclick = function() {
            document.getElementById('incomingCall').hidden = true;
            // Update log from missed to incoming
            callLog[missedIdx].type = 'incoming';
            callStartTime = Date.now();
            localStorage.setItem('toki_calllog', JSON.stringify(callLog));

            var constraints = { audio: true, video: true };
            navigator.mediaDevices.getUserMedia(constraints).then(function(stream) {
                localStream = stream;
                document.getElementById('localVideo').srcObject = stream;
                document.getElementById('callScreen').classList.add('active');
                document.getElementById('callInfo').textContent = 'Connected';

                call.answer(stream);
                currentCall = call;

                call.on('stream', function(remoteStream) {
                    document.getElementById('remoteVideo').srcObject = remoteStream;
                });

                call.on('close', function() {
                    endCall();
                });
            });
        };

        document.getElementById('declineCallBtn').onclick = function() {
            document.getElementById('incomingCall').hidden = true;
            // Update log to rejected
            callLog[missedIdx].type = 'rejected';
            localStorage.setItem('toki_calllog', JSON.stringify(callLog));
            call.close();
        };

        // If not answered within 30 seconds, dismiss and keep as missed
        setTimeout(function() {
            if (document.getElementById('incomingCall').hidden === false) {
                document.getElementById('incomingCall').hidden = true;
            }
        }, 30000);
    };

    // Call controls
    document.getElementById('toggleMicBtn').addEventListener('click', function() {
        if (!localStream) return;
        micEnabled = !micEnabled;
        localStream.getAudioTracks().forEach(function(t) { t.enabled = micEnabled; });
        this.textContent = micEnabled ? '🎤' : '🔇';
        this.classList.toggle('muted', !micEnabled);
    });

    document.getElementById('toggleCamBtn').addEventListener('click', function() {
        if (!localStream) return;
        camEnabled = !camEnabled;
        localStream.getVideoTracks().forEach(function(t) { t.enabled = camEnabled; });
        this.textContent = camEnabled ? '📷' : '🚫';
        this.classList.toggle('muted', !camEnabled);
    });

    document.getElementById('hangupBtn').addEventListener('click', function() {
        // Send hangup signal to the other side
        if (currentRoom) {
            PeerManager.sendMessage(currentRoom, {
                type: 'hangup',
                sender: account.peerId,
                roomCode: currentRoom
            });
        }
        endCall();
    });

    var usingFrontCamera = true;
    document.getElementById('switchCamBtn').addEventListener('click', function() {
        if (!localStream) return;
        usingFrontCamera = !usingFrontCamera;
        var constraints = {
            audio: true,
            video: { facingMode: usingFrontCamera ? 'user' : 'environment' }
        };
        // Stop current video track
        localStream.getVideoTracks().forEach(function(t) { t.stop(); });
        navigator.mediaDevices.getUserMedia(constraints).then(function(newStream) {
            var newVideoTrack = newStream.getVideoTracks()[0];
            // Replace track in local stream
            var oldVideoTrack = localStream.getVideoTracks()[0];
            localStream.removeTrack(oldVideoTrack);
            localStream.addTrack(newVideoTrack);
            document.getElementById('localVideo').srcObject = localStream;
            // Replace track in peer connection
            if (currentCall && currentCall.peerConnection) {
                var sender = currentCall.peerConnection.getSenders().find(function(s) {
                    return s.track && s.track.kind === 'video';
                });
                if (sender) sender.replaceTrack(newVideoTrack);
            }
        }).catch(function(err) {
            console.error('Switch camera failed:', err);
        });
    });

    function endCall() {
        // Update call log with duration
        if (callStartTime && callLog.length > 0) {
            var duration = Math.floor((Date.now() - callStartTime) / 1000);
            callLog[callLog.length - 1].duration = duration;
            localStorage.setItem('toki_calllog', JSON.stringify(callLog));
            callStartTime = null;
        }

        // Send hangup signal to peer
        if (currentRoom) {
            PeerManager.sendMessage(currentRoom, {
                type: 'hangup',
                sender: account.peerId
            });
        }

        endCallLocal();
    }

    function endCallLocal() {
        if (callStartTime && callLog.length > 0) {
            var duration = Math.floor((Date.now() - callStartTime) / 1000);
            callLog[callLog.length - 1].duration = duration;
            localStorage.setItem('toki_calllog', JSON.stringify(callLog));
            callStartTime = null;
        }
        if (currentCall) { currentCall.close(); currentCall = null; }
        if (localStream) {
            localStream.getTracks().forEach(function(t) { t.stop(); });
            localStream = null;
        }
        document.getElementById('callScreen').classList.remove('active');
        document.getElementById('localVideo').srcObject = null;
        document.getElementById('remoteVideo').srcObject = null;
        document.getElementById('localVideo').style.display = '';
        document.getElementById('remoteVideo').style.display = '';
        micEnabled = true;
        camEnabled = true;
        document.getElementById('toggleMicBtn').textContent = '🎤';
        document.getElementById('toggleCamBtn').textContent = '📷';
    }

    // Handle incoming messages
    // Unread message tracking

    function handleIncomingMessage(data) {
        if (data.type === 'message' && data.roomCode) {
            // Only process if it has content
            if (!data.sender || (!data.text && !data.media && !data.location && !data.animation)) return;

            // Check if sender is blocked
            var blocked = JSON.parse(localStorage.getItem('toki_blocked') || '[]');
            if (blocked.indexOf(data.sender) !== -1) return;

            // Deduplicate - skip if we already processed this message
            if (data.msgId && !data.isLiveLocationUpdate) {
                if (processedMsgIds[data.msgId]) return;
                processedMsgIds[data.msgId] = true;
            }

            // Live location update — replace existing message
            if (data.isLiveLocationUpdate && data.msgId) {
                var msgs = Storage.getMessages(data.roomCode);
                var existingIdx = -1;
                for (var i = 0; i < msgs.length; i++) {
                    if (msgs[i].msgId === data.msgId) {
                        existingIdx = i;
                        break;
                    }
                }
                if (existingIdx >= 0) {
                    msgs[existingIdx] = data;
                    localStorage.setItem('messenger_msgs_' + data.roomCode, JSON.stringify(msgs));
                } else {
                    Storage.saveMessage(data.roomCode, data);
                }
            } else {
                Storage.saveMessage(data.roomCode, data);
            }

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
                // Show system notification
                showSystemNotification(data.senderName || 'New message', data.text || (data.animation ? '🎁 Animation' : '📎 Media'), data.roomCode);
            }

            // Update page title with total unread
            updateTitleBadge();
            renderChatList();
        } else if (data.type === 'invite') {
            // Handle group invite
            if (data.invitedPeer === account.peerId || !data.invitedPeer) {
                handleInvite(data);
            }
        } else if (data.type === 'hangup') {
            // Other side ended the call
            endCall();
        } else if (data.type === 'deleteGroup') {
            // Handle group deletion from creator
            if (data.roomCode) {
                var chats = Storage.getChats().filter(function(c) { return c.roomCode !== data.roomCode; });
                Storage.saveChats(chats);
                localStorage.removeItem('messenger_msgs_' + data.roomCode);
                if (currentRoom === data.roomCode) {
                    currentRoom = null;
                    document.getElementById('chatHeader').innerHTML = '<span class="chat-title">Select or start a chat</span>';
                    document.getElementById('messages').innerHTML = '';
                    document.getElementById('messageInputArea').hidden = true;
                }
                renderChatList();
                alert(data.senderName + ' deleted the group.');
            }
        } else if (data.type === 'hangup') {
            // Other side ended the call
            if (currentCall) {
                currentCall.close();
                currentCall = null;
            }
            if (localStream) {
                localStream.getTracks().forEach(function(t) { t.stop(); });
                localStream = null;
            }
            document.getElementById('callScreen').classList.remove('active');
            document.getElementById('localVideo').srcObject = null;
            document.getElementById('remoteVideo').srcObject = null;
            document.getElementById('incomingCall').hidden = true;
            if (callStartTime && callLog.length > 0) {
                var duration = Math.floor((Date.now() - callStartTime) / 1000);
                callLog[callLog.length - 1].duration = duration;
                localStorage.setItem('toki_calllog', JSON.stringify(callLog));
                callStartTime = null;
            }
            micEnabled = true;
            camEnabled = true;
        } else if (data.type === 'delete') {
            // Handle delete for everyone
            if (data.msgId && data.roomCode) {
                var msgs = Storage.getMessages(data.roomCode);
                for (var i = 0; i < msgs.length; i++) {
                    if (msgs[i].msgId === data.msgId) {
                        msgs[i].deleted = true;
                        msgs[i].text = '';
                        msgs[i].media = null;
                        msgs[i].location = null;
                        break;
                    }
                }
                localStorage.setItem('messenger_msgs_' + data.roomCode, JSON.stringify(msgs));
                if (currentRoom === data.roomCode) {
                    renderMessages(data.roomCode);
                }
            }
        } else if (data.type === 'hangup') {
            // Other side ended the call
            if (currentCall) {
                endCallLocal();
            }
        } else if (data.type === 'receipt') {
            // Update message status - track per user for group chats
            var msgs = Storage.getMessages(data.roomCode);
            var updated = false;
            for (var i = 0; i < msgs.length; i++) {
                if (msgs[i].msgId === data.msgId) {
                    // Track receipts per user
                    if (!msgs[i].receipts) msgs[i].receipts = {};
                    if (!msgs[i].receipts[data.sender]) msgs[i].receipts[data.sender] = {};

                    if (data.receiptType === 'delivered') {
                        msgs[i].receipts[data.sender].delivered = true;
                        msgs[i].delivered = true;
                    } else if (data.receiptType === 'read') {
                        msgs[i].receipts[data.sender].delivered = true;
                        msgs[i].receipts[data.sender].read = true;
                        msgs[i].delivered = true;

                        // Check if ALL users have read (for group chats)
                        var totalPeers = PeerManager.getConnectedPeers(data.roomCode);
                        var readCount = 0;
                        for (var peer in msgs[i].receipts) {
                            if (msgs[i].receipts[peer].read) readCount++;
                        }
                        // Mark as fully read if all connected peers have read
                        if (readCount >= totalPeers || totalPeers <= 1) {
                            msgs[i].read = true;
                        }
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

    function showSystemNotification(senderName, text, roomCode) {
        if (!('Notification' in window)) return;
        if (Notification.permission !== 'granted') return;
        if (!document.hidden) return;
        if (localStorage.getItem('toki_muted_' + roomCode)) return; // Muted

        var body = text || '📎 Media';
        if (body.length > 50) body = body.substring(0, 50) + '...';

        var notification = new Notification(senderName, {
            body: body,
            icon: 'logo.svg',
            tag: roomCode // Prevents duplicate notifications for same chat
        });

        notification.onclick = function() {
            window.focus();
            selectChat(roomCode);
            notification.close();
        };

        // Auto-close after 5 seconds
        setTimeout(function() { notification.close(); }, 5000);
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
    function formatLastSeen(timestamp) {
        var now = Date.now();
        var diff = now - timestamp;
        var mins = Math.floor(diff / 60000);
        if (mins < 2) return 'last seen just now';
        if (mins < 60) return 'last seen ' + mins + 'm ago';
        var hours = Math.floor(mins / 60);
        if (hours < 24) return 'last seen ' + hours + 'h ago';
        return 'last seen ' + Math.floor(hours / 24) + 'd ago';
    }

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
