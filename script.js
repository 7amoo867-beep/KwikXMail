let currentLang = 'ar';

function switchLanguage(lang) {
    currentLang = lang;
    document.documentElement.lang = lang;
    document.documentElement.dir = lang === 'ar' ? 'rtl' : 'ltr';
    
    document.getElementById('currentLangText').innerText = lang === 'ar' ? 'العربية' : 'English';

    document.querySelectorAll('.t').forEach(el => {
        el.innerHTML = el.getAttribute('data-' + lang);
    });

    if(document.getElementById("inboxMessages").innerText.includes("فارغ") || document.getElementById("inboxMessages").innerText.includes("empty")) {
        let emptyMsg = lang === 'ar' ? "الصندوق فارغ حالياً. في انتظار رسائل جديدة..." : "Inbox is empty. Waiting for new messages...";
        document.getElementById("inboxMessages").innerHTML = `<span class="t">${emptyMsg}</span>`;
    }
}

function updateFullEmail() {
    var name = document.getElementById("emailName").value;
    var domain = document.getElementById("domainSelect").value;
    document.getElementById("fullEmailHidden").value = name + domain;
}

function copyEmail() {
    var hiddenInput = document.getElementById("fullEmailHidden");
    navigator.clipboard.writeText(hiddenInput.value);
    let msg = currentLang === 'ar' ? "تم نسخ الإيميل: " : "Email copied: ";
    alert(msg + hiddenInput.value);
}

function generateNewEmail() {
    const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
    let randomString = '';
    for (let i = 0; i < 8; i++) {
        randomString += chars[Math.floor(Math.random() * chars.length)];
    }
    document.getElementById("emailName").value = randomString;
    updateFullEmail();
    resetTimer();
    let emptyMsg = currentLang === 'ar' ? "الصندوق فارغ حالياً. في انتظار رسائل جديدة..." : "Inbox is empty. Waiting for new messages...";
    document.getElementById("inboxMessages").innerHTML = `<span class="t">${emptyMsg}</span>`;
}

function simulateNewMessage() {
    var icon = document.getElementById("refreshIcon");
    icon.classList.add("fa-spin");
    
    setTimeout(function() {
        icon.classList.remove("fa-spin");
        
        let sender = currentLang === 'ar' ? "نتفليكس (محاكاة)" : "Netflix (Simulation)";
        let msgText = currentLang === 'ar' ? "رمز التحقق الخاص بك هو:" : "Your verification code is:";
        
        var inbox = document.getElementById("inboxMessages");
        inbox.innerHTML = `
            <div class="otp-message">
                <strong style="color: #fff; font-size: 1.1rem;">${sender}</strong>
                <p style="margin: 5px 0; font-size: 0.9rem; color: #aaa;">${msgText}</p>
                <div class="otp-code">940 281</div>
            </div>
        `;
    }, 1500);
}

function deleteEmail() {
    document.getElementById("emailName").value = "deleted";
    updateFullEmail();
    let delMsg = currentLang === 'ar' ? "تم تدمير البريد. يرجى إنشاء بريد جديد." : "Email destroyed. Please generate a new one.";
    document.getElementById("inboxMessages").innerHTML = `<span style='color:#e74c3c;'>${delMsg}</span>`;
}

function toggleArticle(element) {
    element.classList.toggle('active');
}

let timeLeft = 600; 
let timerInterval;

function startTimer() {
    timerInterval = setInterval(function() {
        if (timeLeft <= 0) {
            clearInterval(timerInterval);
            deleteEmail();
            return;
        }
        timeLeft--;
        let minutes = Math.floor(timeLeft / 60);
        let seconds = timeLeft % 60;
        document.getElementById("timeDisplay").innerText = 
            (minutes < 10 ? "0" : "") + minutes + ":" + (seconds < 10 ? "0" : "") + seconds;
    }, 1000);
}

function resetTimer() {
    clearInterval(timerInterval);
    timeLeft = 600;
    startTimer();
}

window.onload = function() {
    startTimer();
};