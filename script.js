let currentLang = 'ar';
let currentAccount = null;
let currentToken = null;
let pollingInterval = null;

// ====================== Mail.tm API ======================
async function getDomains() {
    try {
        const res = await fetch('https://api.mail.tm/domains');
        const data = await res.json();
        return data['hydra:member'];
    } catch (e) {
        return [{ domain: "mail.tm" }];
    }
}

async function populateDomains() {
    const domains = await getDomains();
    const select = document.getElementById("domainSelect");
    select.innerHTML = '';
    domains.forEach(d => {
        const opt = document.createElement('option');
        opt.value = '@' + d.domain;
        opt.textContent = '@' + d.domain;
        select.appendChild(opt);
    });
    updateFullEmail();
}

async function createAccount() {
    const domains = await getDomains();
    const domain = domains[Math.floor(Math.random()*domains.length)].domain;
    const username = 'user' + Math.random().toString(36).substring(2, 11);
    const password = 'pass123456';

    try {
        const res = await fetch('https://api.mail.tm/accounts', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ address: `${username}@${domain}`, password })
        });

        const account = await res.json();
        currentAccount = account;

        const tokenRes = await fetch('https://api.mail.tm/token', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ address: account.address, password })
        });

        const tokenData = await tokenRes.json();
        currentToken = tokenData.token;

        // تحديث الـ select بالدومين الصح
        const select = document.getElementById("domainSelect");
        for (let opt of select.options) {
            if (opt.value === '@' + domain) {
                select.value = opt.value;
                break;
            }
        }

        document.getElementById("emailName").value = username;
        document.getElementById("fullEmailHidden").value = account.address;

        showToast(currentLang === 'ar' ? "✅ تم إنشاء بريد جديد بنجاح!" : "✅ New email created successfully!", "success");
        startPolling();

    } catch (e) {
        console.error(e);
        showToast(currentLang === 'ar' ? "❌ خطأ في الاتصال" : "❌ Connection error", "error");
    }
}

async function fetchMessages() {
    if (!currentToken) return;

    try {
        const res = await fetch('https://api.mail.tm/messages', {
            headers: { 'Authorization': `Bearer ${currentToken}` }
        });
        const data = await res.json();
        const messages = data['hydra:member'] || [];

        const inbox = document.getElementById("inboxMessages");

        if (messages.length === 0) {
            inbox.innerHTML = `<span class="t">${currentLang === 'ar' ? "الصندوق فارغ حالياً. في انتظار رسائل جديدة..." : "Inbox is empty. Waiting for new messages..."}</span>`;
            return;
        }

        let html = '';
        messages.forEach(msg => {
            html += `
                <div class="message-item" style="background:#1f1f1f; padding:12px; margin:8px 0; border-radius:8px; border-left: 4px solid #00cc88;">
                    <strong>${msg.from.name || msg.from.address}</strong><br>
                    <small style="color:#aaa;">${msg.subject || 'No Subject'}</small>
                    <p style="margin:8px 0; font-size:0.95rem; color:#ddd;">${msg.intro || ''}</p>
                    <button onclick="viewMessage('${msg.id}')" style="background:#00cc88; color:black; border:none; padding:6px 14px; border-radius:4px; cursor:pointer; font-weight:bold;">
                        ${currentLang === 'ar' ? 'عرض الرسالة' : 'View Message'}
                    </button>
                </div>
            `;
        });
        inbox.innerHTML = html;
    } catch (e) {
        console.error(e);
    }
}

async function viewMessage(id) {
    if (!currentToken) return;
    try {
        const res = await fetch(`https://api.mail.tm/messages/${id}`, {
            headers: { 'Authorization': `Bearer ${currentToken}` }
        });
        const msg = await res.json();
        alert((currentLang === 'ar' ? 'الرسالة:\n\n' : 'Message:\n\n') + (msg.text || msg.html || msg.intro || 'No content available'));
    } catch (e) {}
}

function startPolling() {
    if (pollingInterval) clearInterval(pollingInterval);
    pollingInterval = setInterval(fetchMessages, 4000);
    fetchMessages();
}

// ====================== UI ======================
function copyEmail() {
    const email = document.getElementById("fullEmailHidden").value;
    if (!email) return;
    navigator.clipboard.writeText(email).then(() => {
        showToast(currentLang === 'ar' ? `✅ تم نسخ: ${email}` : `✅ Copied: ${email}`, "success");
    });
}

function generateNewEmail() {
    if (currentAccount) {
        if (!confirm(currentLang === 'ar' ? "هل تريد إنشاء بريد جديد؟ (الحالي هيتم حذفه)" : "Create new email? Current one will be deleted.")) {
            return;
        }
    }
    createAccount();
}

// ✅ تصليح: الزر كان بيستدعي simulateNewMessage() الغلط
function manualRefresh() {
    const icon = document.getElementById("refreshIcon");
    icon.classList.add("fa-spin");
    fetchMessages().finally(() => {
        setTimeout(() => icon.classList.remove("fa-spin"), 800);
    });
    showToast(currentLang === 'ar' ? "🔄 جاري التحديث..." : "🔄 Refreshing...", "success");
}

function deleteEmail() {
    if (pollingInterval) clearInterval(pollingInterval);
    currentAccount = null;
    currentToken = null;
    document.getElementById("emailName").value = "deleted";
    document.getElementById("fullEmailHidden").value = "";
    document.getElementById("inboxMessages").innerHTML = `<span style='color:#e74c3c;'>${currentLang === 'ar' ? "تم حذف البريد. أنشئ بريد جديد." : "Email deleted. Generate a new one."}</span>`;
    showToast(currentLang === 'ar' ? "🗑️ تم حذف البريد" : "🗑️ Email deleted", "success");
}

function showToast(message, type = "success") {
    const toast = document.createElement('div');
    toast.style.cssText = `
        position: fixed; top: 20px; left: 50%; transform: translateX(-50%);
        padding: 14px 24px; border-radius: 8px; color: white; z-index: 99999;
        font-weight: 600; box-shadow: 0 4px 15px rgba(0,0,0,0.3);
        background: ${type === 'success' ? '#00cc88' : '#ff4444'};
        max-width: 90%; text-align: center;
    `;
    toast.textContent = message;
    document.body.appendChild(toast);
    setTimeout(() => {
        toast.style.transition = 'opacity 0.4s';
        toast.style.opacity = '0';
        setTimeout(() => toast.remove(), 400);
    }, 3000);
}

// ====================== Articles Toggle ======================
function toggleArticle(el) {
    const isActive = el.classList.contains('active');
    // أغلق كل المقالات الأول
    document.querySelectorAll('.art-box').forEach(box => box.classList.remove('active'));
    // لو مكنش مفتوح، افتحه
    if (!isActive) el.classList.add('active');
}

// ====================== Language ======================
function switchLanguage(lang) {
    currentLang = lang;
    document.documentElement.lang = lang;
    document.documentElement.dir = lang === 'ar' ? 'rtl' : 'ltr';
    document.getElementById('currentLangText').innerText = lang === 'ar' ? 'العربية' : 'English';
    document.querySelectorAll('.t').forEach(el => {
        const text = el.getAttribute('data-' + lang);
        if (text) el.innerHTML = text;
    });
}

function updateFullEmail() {
    const name = document.getElementById("emailName").value.trim();
    const domain = document.getElementById("domainSelect").value;
    document.getElementById("fullEmailHidden").value = name + domain;
}

// ====================== Init ======================
window.onload = async function() {
    await populateDomains();  // ✅ جلب الدومينات الحقيقية من API
    await createAccount();
    document.getElementById("emailName").addEventListener("input", updateFullEmail);
    document.getElementById("domainSelect").addEventListener("change", updateFullEmail);
};