// index.js

// 1. Kutubxonalarni chaqirish va .env ni yuklash
require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const admin = require('firebase-admin');
const axios = require('axios');
const FormData = require('form-data');

// 2. Maxfiy ma'lumotlarni Environment Variables (Railway) dan olish
const TOKEN = process.env.TELEGRAM_BOT_TOKEN || '7586941333:AAHKly13Z3M5qkyKjP-6x-thWvXdJudIHsU';
const IMGBB_API_KEY = process.env.IMGBB_API_KEY || '92f447e91c83252eedc95d323bf1b92a';
// Admin ID'lar stringdan Arrayga o'tkaziladi
const admins = (process.env.ADMIN_IDS || '5761225998,7122472578').split(',').map(id => parseInt(id.trim())).filter(id => !isNaN(id));

// 3. 🛠️ FIREBASE'NI SOZLASH (YANGILANGAN QISM - Railway uchun)
let db;
try {
    // 1. JSON stringni ENVIRONMENT VARIABLE'dan o'qish
    const serviceAccountJson = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;

    if (!serviceAccountJson) {
        // Agar o'zgaruvchi yo'q bo'lsa, xato tashlaymiz
        throw new Error("FIREBASE_SERVICE_ACCOUNT_JSON topilmadi. Variables bo'limini tekshiring.");
    }

    // 2. JSON stringni JS obyektiga aylantirish
    const serviceAccount = JSON.parse(serviceAccountJson);

    // 3. Firebase'ni sozlash
    admin.initializeApp({
        credential: admin.credential.cert(serviceAccount),
        databaseURL: "https://oscar-d85af.firebaseio.com" // Loyihangiz nomi
    });
    db = admin.firestore();
    console.log("✅ Firebase muvaffaqiyatli ulangan.");

} catch (error) {
    console.error("❌ Firebase sozlashda KRITIK XATO!", error.message);
    // Xato bo'lsa, loyihaning ishlashiga imkon bermaslik yaxshiroq
}

const bot = new TelegramBot(TOKEN, { polling: true });
const userState = {}; // Foydalanuvchi holatini (step, data, steps) saqlash

// 4. Asosiy boshqaruv klaviaturasi (Bekor qilish tugmasi qo'shilgan)
const mainKeyboard = {
    reply_markup: {
        keyboard: [
            [{ text: "🛍 Mahsulot qo'shish" }, { text: "📂 Kategoriya qo'shish" }],
            [{ text: "📂 Kategoriya yangilash" }, { text: "🔄 Mahsulotni yangilash" }],
            [{ text: "💱 Dollar kursini o'rnatish" }, { text: "📊 Ma'lumotlarni ko'rish" }],
            [{ text: "❌ Bekor qilish" }],
        ],
        resize_keyboard: true,
    },
};

// Orqaga tugmasi bilan universal keyboard
const backKeyboard = {
    reply_markup: {
        keyboard: [["Orqaga"]],
        resize_keyboard: true,
        one_time_keyboard: false
    }
};

// Orqaga + main
const mainBackKeyboard = {
    reply_markup: {
        keyboard: [
            ...mainKeyboard.reply_markup.keyboard.slice(0, -1), // Oxirgi qatorni olib tashlash
            [{ text: "❌ Bekor qilish" }, { text: "Orqaga" }]
        ],
        resize_keyboard: true,
    },
};

// 5. Yordamchi funksiyalar
// --------------------------------------------------------------------------------------

/**
 * Berilgan collection ichidagi eng katta IDni topib, uning keyingisini qaytaradi.
 */
async function getNextId(collectionName) {
    // Firebase ulanmagan bo'lsa, -1 qaytarish
    if (!db) return -1; 
    try {
        const snapshot = await db.collection(collectionName).orderBy('id', 'desc').limit(1).get();
        if (snapshot.empty) return 1;
        const lastId = snapshot.docs[0].data().id;
        const lastIdNum = parseInt(lastId);
        if (isNaN(lastIdNum) || lastIdNum <= 0) return 1;
        return lastIdNum + 1; 
    } catch (error) {
        console.error(`Error in getNextId for ${collectionName}:`, error);
        return -1;
    }
}

/**
 * Rasmni ImgBB'ga yuklash va URL qaytarish.
 */
async function uploadToImgBB(fileId) {
    try {
        const file = await bot.getFile(fileId);
        const fileUrl = `https://api.telegram.org/file/bot${TOKEN}/${file.file_path}`;

        const response = await axios.get(fileUrl, { responseType: 'arraybuffer' });
        const buffer = Buffer.from(response.data);

        const form = new FormData();
        form.append('key', IMGBB_API_KEY);
        form.append('image', buffer, {
            filename: 'product_image.jpg',
            contentType: 'image/jpeg'
        });

        const uploadResponse = await axios.post('https://api.imgbb.com/1/upload', form, {
            headers: { ...form.getHeaders() }
        });

        if (uploadResponse.data.success) {
            return uploadResponse.data.data.url;
        } else {
            console.error('ImgBB yuklash muvaffaqiyatsiz:', uploadResponse.data);
            throw new Error('ImgBB yuklash muvaffaqiyatsiz');
        }
    } catch (error) {
        console.error('ImgBB yuklashda xato:', error.message || error);
        return null;
    }
}

// Kategoriyadagi mahsulotlar sonini olish
async function getProductsInCategory(categoryName) {
    if (!db) return 0;
    try {
        const snapshot = await db.collection('products').where('category', '==', categoryName).get();
        return snapshot.size;
    } catch (error) {
        console.error('Kategoriyadagi mahsulotlar sonini olishda xato:', error);
        return 0;
    }
}

// State'ni tozalash funksiyasi
function resetUserState(chatId) {
    userState[chatId] = { step: 'none', data: {}, steps: [] };
}

// Orqaga qaytish handler
async function handleBack(chatId) {
    const state = userState[chatId];
    if (!state || state.steps.length === 0) {
        resetUserState(chatId);
        bot.sendMessage(chatId, "Bosh menyu.", mainKeyboard);
        return;
    }

    const prevStep = state.steps.pop();
    state.step = prevStep;

    // Prev step ga qarab message yuborish
    if (prevStep.startsWith('product_')) {
        await handleProductStep(chatId, prevStep, true); // true - back dan
    } else if (prevStep.startsWith('category_')) {
        await handleCategoryStep(chatId, prevStep, true);
    } else if (prevStep === 'usd_rate') {
        bot.sendMessage(chatId, "💱 Dollar kursini o'rnatishni tanlang.", mainBackKeyboard);
        state.step = 'usd_rate'; // Qayta so'rash uchun
    } else {
        bot.sendMessage(chatId, "Bosh menyu.", mainKeyboard);
        state.step = 'none';
    }
}

// Tugma buyruqlarini qayta ishlash funksiyasi
async function handleCommand(chatId, text) {
    // Har qanday buyruq oldin state'ni tozalaydi
    resetUserState(chatId);
    
    // Agar db ulanmagan bo'lsa, xabar berish
    if (!db) {
        bot.sendMessage(chatId, "❌ Uzr, Firestore (Database) ulanishi xato bo'ldi. Admin sozlamalarini tekshiring.", mainKeyboard);
        return;
    }

    if (text === "🛍 Mahsulot qo'shish") {
        const categoriesSnapshot = await db.collection('categories').get();
        const categoryNames = categoriesSnapshot.docs.map(doc => doc.data().name);

        if (categoryNames.length === 0) {
            bot.sendMessage(chatId, "Avval kategoriya qo'shing. '📂 Kategoriya qo'shish' ni tanlang.", mainKeyboard);
            return;
        }

        userState[chatId] = { step: 'product_name', data: { categoryNames, priceBox: 0 }, steps: [] };
        bot.sendMessage(chatId, "1/7. Mahsulot nomini kiriting:", backKeyboard);
        return;
    }

    if (text === "📂 Kategoriya qo'shish") {
        userState[chatId] = { step: 'category_name', data: {}, steps: [] };
        bot.sendMessage(chatId, "1/2. Kategoriya nomini kiriting (mas: Oziq-ovqat):", backKeyboard);
        return;
    }

    // Kategoriya yangilash
    if (text === "📂 Kategoriya yangilash") {
        try {
            const categoriesSnapshot = await db.collection('categories').get();
            if (categoriesSnapshot.empty) {
                bot.sendMessage(chatId, "Hech qanday kategoriya topilmadi. Avval qo'shing.", mainKeyboard);
                return;
            }

            const categories = categoriesSnapshot.docs.map(doc => {
                const data = doc.data();
                return { id: data.id, name: data.name, icon: data.icon };
            });

            const inlineKeyboard = { reply_markup: { inline_keyboard: [] } };

            for (let i = 0; i < categories.length; i += 2) {
                const row = [{ text: `${categories[i].icon} ${categories[i].name}`, callback_data: `update_category_${categories[i].id}` }];
                if (i + 1 < categories.length) {
                    row.push({ text: `${categories[i + 1].icon} ${categories[i + 1].name}`, callback_data: `update_category_${categories[i + 1].id}` });
                }
                inlineKeyboard.reply_markup.inline_keyboard.push(row);
            }
            
            bot.sendMessage(chatId, "Qaysi kategoriyani yangilashni xohlaysiz? (Inline tugmalardan tanlang):", inlineKeyboard);
        } catch (error) {
            console.error("Kategoriyalarni olishda xato:", error);
            bot.sendMessage(chatId, "❌ Kategoriyalarni olishda xato yuz berdi!", mainKeyboard);
        }
        return;
    }

    if (text === "💱 Dollar kursini o'rnatish") {
        userState[chatId] = { step: 'usd_rate', data: {}, steps: [] };
        bot.sendMessage(chatId, "USD to UZS kursini kiriting (masalan: 12600):", backKeyboard);
        return;
    }
    
    if (text === "❌ Bekor qilish") {
        resetUserState(chatId);
        bot.sendMessage(chatId, "Joriy amal bekor qilindi.", mainKeyboard);
        return;
    }

    // Mahsulotni yangilash
    if (text === "🔄 Mahsulotni yangilash") {
        try {
            const categoriesSnapshot = await db.collection('categories').get();
            if (categoriesSnapshot.empty) {
                bot.sendMessage(chatId, "Hech qanday kategoriya topilmadi. Avval qo'shing.", mainKeyboard);
                return;
            }

            const categories = categoriesSnapshot.docs.map(doc => {
                const data = doc.data();
                return { id: data.id, name: data.name, icon: data.icon };
            });

            const inlineKeyboard = { reply_markup: { inline_keyboard: [] } };

            for (let i = 0; i < categories.length; i += 2) {
                const row = [{ text: `${categories[i].icon} ${categories[i].name}`, callback_data: `select_category_${categories[i].id}` }];
                if (i + 1 < categories.length) {
                    row.push({ text: `${categories[i + 1].icon} ${categories[i + 1].name}`, callback_data: `select_category_${categories[i + 1].id}` });
                }
                inlineKeyboard.reply_markup.inline_keyboard.push(row);
            }
            
            bot.sendMessage(chatId, "Qaysi kategoriyadagi mahsulotni yangilashni xohlaysiz? (Inline tugmalardan tanlang):", inlineKeyboard);
        } catch (error) {
            console.error("Kategoriyalarni olishda xato:", error);
            bot.sendMessage(chatId, "❌ Kategoriyalarni olishda xato yuz berdi!", mainKeyboard);
        }
        return;
    }

    if (text === "📊 Ma'lumotlarni ko'rish") {
        try {
            const productsSnapshot = await db.collection('products').get();
            const categoriesSnapshot = await db.collection('categories').get();
            const settingsSnapshot = await db.collection('settings').doc('usdRate').get();
            const usdRate = settingsSnapshot.exists ? settingsSnapshot.data().rate : 'Belgilanmagan';

            bot.sendMessage(chatId, 
                `📊 **Statistika:**\n\n` +
                `🔹 **Mahsulotlar soni:** ${productsSnapshot.size.toLocaleString()} ta\n` +
                `🔹 **Kategoriyalar soni:** ${categoriesSnapshot.size.toLocaleString()} ta\n` +
                `💱 **USD kursi:** ${usdRate === 'Belgilanmagan' ? usdRate : usdRate.toLocaleString() + ' so\'m'}\n\n` +
                `Barcha ma'lumotlar Firestore (Firebase) da saqlanmoqda.`, 
                { ...mainKeyboard, parse_mode: 'Markdown' }
            );
        } catch (error) {
            console.error("Statistika olishda xato:", error);
            bot.sendMessage(chatId, "❌ Ma'lumotlarni olishda xato yuz berdi!", mainKeyboard);
        }
        return;
    }

    // Agar hech qanday buyruq mos kelmasa
    bot.sendMessage(chatId, "Tushunmadim. Iltimos, quyidagi tugmalardan birini tanlang:", mainKeyboard);
}

// Mahsulot bosqichlarini handle qilish (back uchun ham)
async function handleProductStep(chatId, currentStep, isBack = false) {
    const state = userState[chatId];
    const data = state.data;
    const oldStep = state.step;
    if (!isBack) {
        state.steps.push(oldStep);
    }

    switch (currentStep) {
        case 'product_name':
            state.step = 'product_name';
            bot.sendMessage(chatId, "1/7. Mahsulot nomini kiriting:", backKeyboard);
            break;
        case 'product_price_piece':
            state.step = 'product_price_piece';
            bot.sendMessage(chatId, "2/7. Dona narxi (USD, raqam, mas: 5.50):", backKeyboard);
            break;
        case 'product_discount':
            state.step = 'product_discount';
            bot.sendMessage(chatId, "3/7. Chegirma (0-100, mas: 10):", backKeyboard);
            break;
        case 'product_category':
            state.step = 'product_category';
            const categoryKeyboard = { 
                reply_markup: { 
                    keyboard: [...data.categoryNames.map(name => [{ text: name }]), ["Orqaga"]], 
                    resize_keyboard: true, 
                    one_time_keyboard: true 
                } 
            };
            bot.sendMessage(chatId, "4/7. Kategoriyani tanlang:", categoryKeyboard);
            break;
        case 'product_image':
            state.step = 'product_image';
            bot.sendMessage(chatId, "5/7. Rasm yuboring (photo formatida):", mainBackKeyboard);
            break;
        case 'product_description':
            state.step = 'product_description';
            bot.sendMessage(chatId, "6/7. Tavsif (qisqa ma'lumot):", backKeyboard);
            break;
        case 'product_box_capacity':
            state.step = 'product_box_capacity';
            bot.sendMessage(chatId, "7/7. Har bir karobkada necha dona bor (raqam, mas: 20):", backKeyboard);
            break;
        case 'product_stock':
            state.step = 'product_stock';
            bot.sendMessage(chatId, "8/7. Ombordagi jami stock (dona soni, mas: 100):", backKeyboard);
            break;
    }
}

// Kategoriya bosqichlarini handle qilish
async function handleCategoryStep(chatId, currentStep, isBack = false) {
    const state = userState[chatId];
    const data = state.data;
    const oldStep = state.step;
    if (!isBack) {
        state.steps.push(oldStep);
    }

    switch (currentStep) {
        case 'category_name':
            state.step = 'category_name';
            bot.sendMessage(chatId, "1/2. Kategoriya nomini kiriting (mas: Oziq-ovqat):", backKeyboard);
            break;
        case 'category_icon':
            state.step = 'category_icon';
            bot.sendMessage(chatId, "2/2. Ikonka (emoji, mas: 🥄):", backKeyboard);
            break;
    }
}

// 6. Asosiy message handler
// --------------------------------------------------------------------------------------

// Tugma buyruqlarining to'liq ro'yxati
const commandButtons = [
    "🛍 Mahsulot qo'shish",
    "📂 Kategoriya qo'shish",
    "📂 Kategoriya yangilash",
    "🔄 Mahsulotni yangilash",
    "💱 Dollar kursini o'rnatish",
    "📊 Ma'lumotlarni ko'rish",
    "❌ Bekor qilish"
];

bot.on('message', async (msg) => {
    const chatId = msg.chat.id;
    const text = msg.text;
    const photo = msg.photo;

    // Faqat admin uchun ruxsat
    if (!admins.includes(chatId)) {
        bot.sendMessage(chatId, "Bu bot faqat administratorlar uchun mo'ljallangan.");
        return;
    }
    
    // Agar db ulanmagan bo'lsa, ma'lumot kiritishga ruxsat bermaslik
    if (!db) {
        bot.sendMessage(chatId, "❌ Uzr, Database ulanishi yo'q. Avval Railway Variables ni tekshiring.");
        return;
    }

    // /start buyrug'ini tekshirish
    if (text && text.startsWith('/')) {
        if (text === '/start') {
            resetUserState(chatId);
            bot.sendMessage(chatId, "Xush kelibsiz! Admin paneliga kirish uchun tugmalardan birini tanlang.", mainKeyboard);
        } else {
            bot.sendMessage(chatId, "Noma'lum buyruq. /start ni bosing.", mainKeyboard);
        }
        return;
    }

    // Orqaga tugmasini tekshirish
    if (text === "Orqaga") {
        await handleBack(chatId);
        return;
    }

    // Tugma buyruqlarini tekshirish (handleCommand ga o'tkazish)
    if (text && commandButtons.includes(text)) {
        await handleCommand(chatId, text);
        return;
    }

    // Agar photo bo'lsa, uni alohida handler'ga o'tkazamiz
    if (photo && !text) {
        return bot.emit('photo', msg);
    }

    // Joriy state'ni tekshirish
    if (!userState[chatId] || userState[chatId].step === 'none') {
        bot.sendMessage(chatId, "Tushunmadim. Iltimos, quyidagi tugmalardan birini tanlang:", mainKeyboard);
        return;
    }

    const state = userState[chatId];
    const step = state.step;
    let data = state.data;

    // Xavfsizlik tekshiruvlari (buyruqlar yoki tugmalar)
    if (text && (text.startsWith('/') || commandButtons.includes(text))) {
        bot.sendMessage(chatId, "Iltimos, Buyruqlar yoki Tugmalarni emas, ma'lumot kiriting. Orqaga bosib oldingizga qayting.");
        return;
    }

    // --- Mahsulot qo'shish bosqichlari (price_box olib tashlandi, priceBox=0; bosqichlar 7 ta) ---
    if (step.startsWith('product_')) {
        const oldStep = step;
        switch (step) {
            case 'product_name':
                data.name = text;
                state.steps.push(oldStep);
                state.step = 'product_price_piece';
                bot.sendMessage(chatId, "2/7. Dona narxi (USD, raqam, mas: 5.50):", backKeyboard);
                break;
            case 'product_price_piece':
                if (!/^\d+(\.\d{1,2})?$/.test(text) || parseFloat(text) <= 0) {
                    bot.sendMessage(chatId, "Musbat son kiriting (masalan: 5 yoki 5.50)!");
                    return;
                }
                data.pricePiece = parseFloat(text);
                state.steps.push(oldStep);
                state.step = 'product_discount';
                bot.sendMessage(chatId, "3/7. Chegirma (0-100, mas: 10):", backKeyboard);
                break;
            case 'product_discount':
                if (!/^\d+$/.test(text) || parseInt(text) < 0 || parseInt(text) > 100) {
                    bot.sendMessage(chatId, "0 dan 100 gacha son kiriting!");
                    return;
                }
                data.discount = parseInt(text);
                state.steps.push(oldStep);
                state.step = 'product_category';
                const categoryKeyboard = { 
                    reply_markup: { 
                        keyboard: data.categoryNames.map(name => [{ text: name }]).concat([["Orqaga"]]), 
                        resize_keyboard: true, 
                        one_time_keyboard: true 
                    } 
                };
                bot.sendMessage(chatId, "4/7. Kategoriyani tanlang:", categoryKeyboard);
                break;
            case 'product_category':
                if (!data.categoryNames.includes(text)) {
                    bot.sendMessage(chatId, "Iltimos, kategoriyani tugmalardan tanlang!");
                    return;
                }
                data.category = text;
                state.steps.push(oldStep);
                state.step = 'product_image';
                bot.sendMessage(chatId, "5/7. Rasm yuboring (photo formatida):", mainBackKeyboard); 
                break;
            case 'product_image':
                // Photo handler ga o'tadi
                return;
            case 'product_description':
                data.description = text;
                state.steps.push(oldStep);
                state.step = 'product_box_capacity';
                bot.sendMessage(chatId, "7/7. Har bir karobkada necha dona bor (raqam, mas: 20):", backKeyboard);
                break;
            case 'product_box_capacity':
                if (!/^\d+$/.test(text) || parseInt(text) <= 0) {
                    bot.sendMessage(chatId, "Musbat son kiriting!");
                    return;
                }
                data.boxCapacity = parseInt(text);
                state.steps.push(oldStep);
                state.step = 'product_stock';
                bot.sendMessage(chatId, "8/7. Ombordagi jami stock (dona soni, mas: 100):", backKeyboard);
                break;
            case 'product_stock':
                if (!/^\d+$/.test(text) || parseInt(text) < 0) {
                    bot.sendMessage(chatId, "0 yoki musbat son kiriting!");
                    return;
                }
                data.stock = parseInt(text);

                // Yangi mahsulotni saqlash (priceBox=0)
                const newId = await getNextId('products');
                if (newId === -1) {
                    bot.sendMessage(chatId, "❌ Mahsulot ID sini olishda xato yuz berdi!", mainKeyboard);
                    resetUserState(chatId);
                    return;
                }
                
                const newProduct = {
                    id: newId,
                    name: data.name,
                    priceBox: data.priceBox, // 0
                    pricePiece: data.pricePiece,
                    discount: data.discount,
                    category: data.category,
                    image: data.image,
                    description: data.description,
                    boxCapacity: data.boxCapacity,
                    stock: data.stock,
                };

                try {
                    await db.collection('products').doc(String(newId)).set(newProduct);
                    bot.sendMessage(chatId, 
                        `✅ Mahsulot **muvaffaqiyatli qo'shildi!**\n\n` +
                        `**Nomi:** ${newProduct.name}\n` +
                        `**Karobka narxi:** ${newProduct.priceBox} $\n` +
                        `**Dona narxi:** ${newProduct.pricePiece.toFixed(2)} $\n` +
                        `**Chegirma:** ${newProduct.discount}%\n` +
                        `**Stock:** ${newProduct.stock.toLocaleString()} dona`, 
                        { ...mainKeyboard, parse_mode: 'Markdown' }
                    );
                } catch (error) {
                    console.error("Mahsulot qo'shishda xato:", error);
                    bot.sendMessage(chatId, "❌ Mahsulot qo'shishda xato yuz berdi!");
                }

                resetUserState(chatId);
                break;
        }
        state.data = data;
        return;
    }

    // --- Kategoriya qo'shish bosqichlari ---
    if (step.startsWith('category_')) {
        const oldStep = step;
        switch (step) {
            case 'category_name':
                data.name = text;
                state.steps.push(oldStep);
                state.step = 'category_icon';
                bot.sendMessage(chatId, "2/2. Ikonka (emoji, mas: 🥄):", backKeyboard);
                break;
            case 'category_icon':
                data.icon = text;

                const newId = await getNextId('categories');
                if (newId === -1) {
                    bot.sendMessage(chatId, "❌ Kategoriya ID sini olishda xato yuz berdi!", mainKeyboard);
                    resetUserState(chatId);
                    return;
                }
                
                const newCategory = { id: newId, name: data.name, icon: data.icon };
                try {
                    await db.collection('categories').doc(String(newId)).set(newCategory);
                    bot.sendMessage(chatId, 
                        `✅ Kategoriya **muvaffaqiyatli qo'shildi!**\n\n` +
                        `**Nomi:** ${newCategory.name}\n` +
                        `**Ikonka:** ${newCategory.icon}`, 
                        { ...mainKeyboard, parse_mode: 'Markdown' }
                    );
                } catch (error) {
                    console.error("Kategoriya qo'shishda xato:", error);
                    bot.sendMessage(chatId, "❌ Kategoriya qo'shishda xato yuz berdi!");
                }
                resetUserState(chatId);
                break;
        }
        state.data = data;
        return;
    }

    // Kategoriya yangilash bosqichlari (text input)
    if (state.step === 'update_category_name') {
        const stateData = state.data;
        console.log(`Updating category name for ID: ${stateData.id}, new name: ${text}`);
        try {
            await db.collection('categories').doc(String(stateData.id)).update({ name: text });
            bot.sendMessage(chatId, 
                `✅ **Kategoriya nomi** yangilandi: **${text}**\n\nEndi boshqa amalni tanlang.`, 
                mainKeyboard
            );
        } catch (error) {
            console.error("Kategoriya nomini yangilashda xato:", error);
            bot.sendMessage(chatId, "❌ Nom yangilashda xato yuz berdi! Xato: " + error.message, mainKeyboard);
        }
        resetUserState(chatId);
        return;
    }

    if (state.step === 'update_category_icon') {
        const stateData = state.data;
        console.log(`Updating category icon for ID: ${stateData.id}, new icon: ${text}`);
        try {
            await db.collection('categories').doc(String(stateData.id)).update({ icon: text });
            bot.sendMessage(chatId, 
                `✅ **Kategoriya ikonka** yangilandi: **${text}**\n\nEndi boshqa amalni tanlang.`, 
                mainKeyboard
            );
        } catch (error) {
            console.error("Kategoriya ikonka yangilashda xato:", error);
            bot.sendMessage(chatId, "❌ Ikonka yangilashda xato yuz berdi! Xato: " + error.message, mainKeyboard);
        }
        resetUserState(chatId);
        return;
    }

    // --- Dollar kursi o'rnatish bosqichi ---
    if (state.step === 'usd_rate') {
        if (!/^\d+$/.test(text) || parseInt(text) <= 0) {
            bot.sendMessage(chatId, "Iltimos, musbat son kiriting!");
            return;
        }
        try {
            const rate = parseInt(text);
            await db.collection('settings').doc('usdRate').set({ rate: rate });
            bot.sendMessage(chatId, `✅ **USD kursi o'rnatildi:** 1$ = ${rate.toLocaleString()} so'm`, { ...mainKeyboard, parse_mode: 'Markdown' });
        } catch (error) {
            console.error("Kurs o'rnatishda xato:", error);
            bot.sendMessage(chatId, "❌ Kurs o'rnatishda xato yuz berdi!");
        }
        resetUserState(chatId);
        return;
    }

    // Yangi qiymatni qabul qilish bosqichi (update_value) - priceBox olib tashlandi, boxCapacity qoldi
    if (state.step === 'update_value') {
        const stateData = state.data;
        let value;
        let fieldType = stateData.field;
        let fieldNameUz;

        if (fieldType.includes('price') || fieldType === 'stock' || fieldType === 'boxCapacity' || fieldType === 'discount') {
            
            const isDiscount = fieldType === 'discount';
            const isStockOrCapacity = fieldType === 'stock' || fieldType === 'boxCapacity';
            
            if (isDiscount) {
                fieldNameUz = 'Chegirma';
                if (!/^\d+$/.test(text) || parseInt(text) < 0 || parseInt(text) > 100) {
                    bot.sendMessage(chatId, "Iltimos, Chegirma uchun 0-100 orasida son kiriting!");
                    return;
                }
                value = parseInt(text);
            } else if (isStockOrCapacity) {
                fieldNameUz = fieldType === 'stock' ? 'Stock' : 'Karobkadagi dona soni';
                 if (!/^\d+$/.test(text) || parseInt(text) < 0) {
                    bot.sendMessage(chatId, `Iltimos, ${fieldNameUz} uchun 0 yoki musbat son kiriting!`);
                    return;
                }
                value = parseInt(text);
            } else {
                fieldNameUz = 'Dona narxi'; // Faqat pricePiece
                if (!/^\d+(\.\d{1,2})?$/.test(text) || parseFloat(text) <= 0) {
                    bot.sendMessage(chatId, `${fieldNameUz} uchun musbat son kiriting (masalan: 5 yoki 5.50)!`);
                    return;
                }
                value = parseFloat(text);
            }

        } else {
            bot.sendMessage(chatId, "Noto'g'ri maydon aniqlandi!");
            resetUserState(chatId);
            return;
        }
        
        try {
            await db.collection('products').doc(String(stateData.id)).update({ [fieldType]: value });
            bot.sendMessage(chatId, 
                `✅ **${fieldNameUz}** yangilandi: **${(typeof value === 'number' && fieldType !== 'discount' ? value.toFixed(2) : value)}** ${fieldType === 'discount' ? '%' : '$/dona'}\n\n` +
                `Endi boshqa amalni tanlang.`, 
                mainKeyboard
            );
        } catch (error) {
            console.error("Yangilashda xato:", error);
            bot.sendMessage(chatId, "❌ Yangilashda xato yuz berdi!", mainKeyboard);
        }

        resetUserState(chatId);
        return;
    }

    // Mahsulot description yangilash
    if (state.step === 'update_product_description') {
        const stateData = state.data;
        try {
            await db.collection('products').doc(String(stateData.id)).update({ description: text });
            bot.sendMessage(chatId, 
                `✅ **Mahsulot tavsifi** yangilandi: **${text.substring(0, 50)}...**\n\nEndi boshqa amalni tanlang.`, 
                mainKeyboard
            );
        } catch (error) {
            console.error("Tavsif yangilashda xato:", error);
            bot.sendMessage(chatId, "❌ Tavsif yangilashda xato yuz berdi!", mainKeyboard);
        }
        resetUserState(chatId);
        return;
    }

    // Mahsulot nomi yangilash
    if (state.step === 'update_product_name') {
        const stateData = state.data;
        try {
            await db.collection('products').doc(String(stateData.id)).update({ name: text });
            bot.sendMessage(chatId, 
                `✅ **Mahsulot nomi** yangilandi: **${text}**\n\nEndi boshqa amalni tanlang.`, 
                mainKeyboard
            );
        } catch (error) {
            console.error("Nomi yangilashda xato:", error);
            bot.sendMessage(chatId, "❌ Nomi yangilashda xato yuz berdi!", mainKeyboard);
        }
        resetUserState(chatId);
        return;
    }

    // Noma'lum holat
    bot.sendMessage(chatId, "Tushunmadim. Orqaga bosib oldingizga qayting yoki ❌ Bekor qilish ni bosing.", mainKeyboard);
});

// 7. Photo handler (rasm yuklash uchun)
// --------------------------------------------------------------------------------------

bot.on('photo', async (msg) => {
    const chatId = msg.chat.id;
    const fileId = msg.photo[msg.photo.length - 1].file_id;

    if (!admins.includes(chatId)) return;
    
    if (!db) {
        bot.sendMessage(chatId, "❌ Uzr, Database ulanishi yo'q. Avval Railway Variables ni tekshiring.");
        return;
    }

    const state = userState[chatId];
    if (state && (state.step === 'product_image' || state.step === 'update_product_image')) {
        let data = state.data;

        const waitMessage = await bot.sendMessage(chatId, "Rasm yuklanmoqda... ⏳");

        const imageUrl = await uploadToImgBB(fileId);
        if (imageUrl) {
            data.image = imageUrl;
            if (state.step === 'product_image') {
                state.steps.push(state.step);
                state.step = 'product_description';
                await bot.editMessageText(`✅ Rasm yuklandi: ${imageUrl.substring(0, 50)}...\n\n6/7. Tavsif (qisqa ma'lumot):`, {
                    chat_id: chatId,
                    message_id: waitMessage.message_id
                });
                bot.sendMessage(chatId, "Tavsifni kiriting:", backKeyboard); // Keyingi input uchun
            } else if (state.step === 'update_product_image') {
                try {
                    await db.collection('products').doc(String(data.id)).update({ image: imageUrl });
                    bot.editMessageText(`✅ **Mahsulot rasmi** yangilandi: ${imageUrl.substring(0, 50)}...\n\nEndi boshqa amalni tanlang.`, {
                        chat_id: chatId,
                        message_id: waitMessage.message_id
                    });
                    resetUserState(chatId);
                } catch (error) {
                    console.error("Rasm yangilashda xato:", error);
                    bot.editMessageText("❌ Rasm yangilashda xato yuz berdi! Qaytadan urinib ko'ring.", {
                        chat_id: chatId,
                        message_id: waitMessage.message_id
                    });
                }
            }
        } else {
            bot.editMessageText("❌ Rasm yuklashda xato yuz berdi! Qaytadan urinib ko'ring.", {
                chat_id: chatId,
                message_id: waitMessage.message_id
            });
        }
        state.data = data;
    } else {
        bot.sendMessage(chatId, "Hozir rasm kutilyapti emas. Tugmalardan foydalaning.", mainKeyboard);
    }
});

// 8. Callback query handler (inline tugmalar uchun) - priceBox olib tashlandi, orqaga qo'shildi
// --------------------------------------------------------------------------------------

bot.on('callback_query', async (callbackQuery) => {
    const chatId = callbackQuery.message.chat.id;
    const data = callbackQuery.data;

    console.log(`Callback received: ${data}`);

    if (!data || !admins.includes(chatId)) {
        bot.answerCallbackQuery(callbackQuery.id, { text: "Ruxsat yo'q!" });
        return;
    }
    
    if (!db) {
        bot.answerCallbackQuery(callbackQuery.id, { text: "Database ulanishi yo'q. Tekshiring." });
        return;
    }
    
    // Kategoriya tanlash (yangilash uchun)
    if (data.startsWith('update_category_')) {
        const categoryIdStr = data.replace('update_category_', '');
        console.log(`Extracted category ID string: ${categoryIdStr}`);
        const categoryIdNum = parseInt(categoryIdStr);
        if (isNaN(categoryIdNum)) {
            console.error(`Invalid category ID: ${categoryIdStr}`);
            bot.answerCallbackQuery(callbackQuery.id, { text: "Noto'g'ri kategoriya ID!" });
            return;
        }
        console.log(`Parsed category ID number: ${categoryIdNum}`);
        try {
            const doc = await db.collection('categories').doc(String(categoryIdNum)).get();
            console.log(`Doc exists: ${doc.exists}`);
            if (!doc.exists) {
                console.error(`Category doc not found for ID: ${categoryIdNum}`);
                bot.answerCallbackQuery(callbackQuery.id, { text: "Kategoriya topilmadi!" });
                return;
            }

            const categoryData = doc.data();
            console.log(`Category data:`, categoryData);
            resetUserState(chatId);
            userState[chatId] = { 
                step: 'update_category_view', 
                data: { id: categoryIdNum, category: categoryData }, 
                steps: []
            };

            const updateKeyboard = {
                reply_markup: {
                    inline_keyboard: [
                        [{ text: `Nomi: ${categoryData.name}`, callback_data: `update_category_name_${categoryIdNum}` }],
                        [{ text: `Ikonka: ${categoryData.icon}`, callback_data: `update_category_icon_${categoryIdNum}` }],
                        [{ text: "🗑 Kategoriyani o'chirish", callback_data: `delete_category_${categoryIdNum}` }],
                        [{ text: "⬅️ Orqaga", callback_data: 'update_cancel' }]
                    ],
                },
            };

            const message = `📝 **Kategoriya:** ${categoryData.icon} ${categoryData.name} (ID: ${categoryIdNum})\n\n` +
                            `Hozirgi qiymatlar:\n` +
                            `• **Nomi:** ${categoryData.name}\n` +
                            `• **Ikonka:** ${categoryData.icon}\n\n` +
                            `Nima o'zgartirishni xohlaysiz? (Tugmani bosing)`;

            bot.editMessageText(message, { 
                chat_id: chatId, message_id: callbackQuery.message.message_id, 
                reply_markup: updateKeyboard.reply_markup, parse_mode: 'Markdown'
            });
            bot.answerCallbackQuery(callbackQuery.id, { text: "Kategoriya tanlandi! Endi o'zgartirish tanlang." });
        } catch (error) {
            console.error("Kategoriyani tanlashda xato:", error);
            bot.answerCallbackQuery(callbackQuery.id, { text: "Xato yuz berdi!" });
        }
        return;
    }

    // Kategoriya nomi o'zgartirish
    if (data.startsWith('update_category_name_')) {
        const categoryIdStr = data.replace('update_category_name_', '');
        console.log(`Extracted category ID for name update: ${categoryIdStr}`);
        const categoryIdNum = parseInt(categoryIdStr);
        if (isNaN(categoryIdNum)) {
            console.error(`Invalid category ID for name update: ${categoryIdStr}`);
            bot.answerCallbackQuery(callbackQuery.id, { text: "Noto'g'ri kategoriya ID!" });
            return;
        }
        console.log(`Parsed category ID for name update: ${categoryIdNum}`);
        userState[chatId] = { step: 'update_category_name', data: { id: categoryIdNum }, steps: [] };
        bot.editMessageText('**Yangi kategoriya nomini** kiriting:', { 
            chat_id: chatId, message_id: callbackQuery.message.message_id, parse_mode: 'Markdown', reply_markup: backKeyboard.reply_markup
        });
        bot.answerCallbackQuery(callbackQuery.id, { text: "Nom o'zgartirish tanlandi! Endi yangi nom yuboring." });
        return;
    }

    // Kategoriya ikonka o'zgartirish
    if (data.startsWith('update_category_icon_')) {
        const categoryIdStr = data.replace('update_category_icon_', '');
        console.log(`Extracted category ID for icon update: ${categoryIdStr}`);
        const categoryIdNum = parseInt(categoryIdStr);
        if (isNaN(categoryIdNum)) {
            console.error(`Invalid category ID for icon update: ${categoryIdStr}`);
            bot.answerCallbackQuery(callbackQuery.id, { text: "Noto'g'ri kategoriya ID!" });
            return;
        }
        console.log(`Parsed category ID for icon update: ${categoryIdNum}`);
        userState[chatId] = { step: 'update_category_icon', data: { id: categoryIdNum }, steps: [] };
        bot.editMessageText('**Yangi kategoriya ikonka** (emoji) ni kiriting:', { 
            chat_id: chatId, message_id: callbackQuery.message.message_id, parse_mode: 'Markdown', reply_markup: backKeyboard.reply_markup
        });
        bot.answerCallbackQuery(callbackQuery.id, { text: "Ikonka o'zgartirish tanlandi! Endi yangi ikonka yuboring." });
        return;
    }

    // Kategoriya o'chirish
    if (data.startsWith('delete_category_')) {
        const categoryIdStr = data.replace('delete_category_', '');
        console.log(`Extracted category ID for delete: ${categoryIdStr}`);
        const categoryIdNum = parseInt(categoryIdStr);
        if (isNaN(categoryIdNum)) {
            console.error(`Invalid category ID for delete: ${categoryIdStr}`);
            bot.answerCallbackQuery(callbackQuery.id, { text: "Noto'g'ri kategoriya ID!" });
            return;
        }
        console.log(`Parsed category ID for delete: ${categoryIdNum}`);
        try {
            const doc = await db.collection('categories').doc(String(categoryIdNum)).get();
            console.log(`Doc exists for delete: ${doc.exists}`);
            if (!doc.exists) {
                console.error(`Category doc not found for delete ID: ${categoryIdNum}`);
                bot.answerCallbackQuery(callbackQuery.id, { text: "Kategoriya topilmadi!" });
                return;
            }
            const categoryData = doc.data();
            const productsCount = await getProductsInCategory(categoryData.name);

            if (productsCount === 0) {
                await db.collection('categories').doc(String(categoryIdNum)).delete();
                bot.editMessageText(`✅ **Kategoriya** "${categoryData.name}" o'chirildi. (Mahsulotlar yo'q edi)`, { 
                    chat_id: chatId, message_id: callbackQuery.message.message_id, parse_mode: 'Markdown'
                });
                bot.answerCallbackQuery(callbackQuery.id, { text: "Kategoriya o'chirildi!" });
            } else {
                const confirmKeyboard = {
                    reply_markup: {
                        inline_keyboard: [
                            [{ text: `Ha, o'chir (shu bilan ${productsCount} ta mahsulot ham o'chadi)`, callback_data: `confirm_delete_category_${categoryIdNum}` }],
                            [{ text: "Yo'q, bekor qilish", callback_data: 'update_cancel' }],
                            [{ text: "⬅️ Orqaga", callback_data: 'update_cancel' }]
                        ],
                    },
                };
                bot.editMessageText(
                    `⚠️ **Ogohlantirish:** "${categoryData.name}" kategoriyasida ${productsCount} ta mahsulot bor.\n\n` +
                    `Rostan ham o'chirmoqchimisiz? (Ha bosilsa, kategoriya va barcha tegishli mahsulotlar o'chiriladi)`, 
                    { 
                        chat_id: chatId, message_id: callbackQuery.message.message_id, 
                        reply_markup: confirmKeyboard.reply_markup, parse_mode: 'Markdown'
                    }
                );
                bot.answerCallbackQuery(callbackQuery.id, { text: `Tasdiqlash kutilmoqda... (${productsCount} ta mahsulot ta'sirlanadi)` });
            }
        } catch (error) {
            console.error("Kategoriya o'chirishda xato:", error);
            bot.answerCallbackQuery(callbackQuery.id, { text: "Xato yuz berdi!" });
        }
        return;
    }

    // Kategoriya o'chirish tasdiqlash
    if (data.startsWith('confirm_delete_category_')) {
        const categoryIdStr = data.replace('confirm_delete_category_', '');
        console.log(`Extracted category ID for confirm delete: ${categoryIdStr}`);
        const categoryIdNum = parseInt(categoryIdStr);
        if (isNaN(categoryIdNum)) {
            console.error(`Invalid category ID for confirm delete: ${categoryIdStr}`);
            bot.answerCallbackQuery(callbackQuery.id, { text: "Noto'g'ri kategoriya ID!" });
            return;
        }
        console.log(`Parsed category ID for confirm delete: ${categoryIdNum}`);
        try {
            const doc = await db.collection('categories').doc(String(categoryIdNum)).get();
            console.log(`Doc exists for confirm delete: ${doc.exists}`);
            if (!doc.exists) {
                console.error(`Category doc not found for confirm delete ID: ${categoryIdNum}`);
                bot.answerCallbackQuery(callbackQuery.id, { text: "Kategoriya topilmadi!" });
                return;
            }
            const categoryData = doc.data();

            await db.collection('categories').doc(String(categoryIdNum)).delete();

            const productsSnapshot = await db.collection('products').where('category', '==', categoryData.name).get();
            for (const productDoc of productsSnapshot.docs) {
                await productDoc.ref.delete();
            }

            bot.editMessageText(`✅ **Kategoriya** "${categoryData.name}" va unga tegishli ${productsSnapshot.size} ta mahsulot o'chirildi.`, { 
                chat_id: chatId, message_id: callbackQuery.message.message_id, parse_mode: 'Markdown'
            });
            bot.answerCallbackQuery(callbackQuery.id, { text: "To'liq o'chirildi!" });
        } catch (error) {
            console.error("Tasdiqlangan o'chirishda xato:", error);
            bot.answerCallbackQuery(callbackQuery.id, { text: "Xato yuz berdi!" });
        }
        return;
    }

    // Mahsulot yangilash uchun kategoriya tanlash
    if (data.startsWith('select_category_')) {
        const categoryIdStr = data.replace('select_category_', '');
        console.log(`Extracted category ID for select: ${categoryIdStr}`);
        const categoryIdNum = parseInt(categoryIdStr);
        if (isNaN(categoryIdNum)) {
            console.error(`Invalid category ID for select: ${categoryIdStr}`);
            bot.answerCallbackQuery(callbackQuery.id, { text: "Noto'g'ri kategoriya ID!" });
            return;
        }
        console.log(`Parsed category ID for select: ${categoryIdNum}`);
        try {
            const doc = await db.collection('categories').doc(String(categoryIdNum)).get();
            console.log(`Doc exists for select: ${doc.exists}`);
            if (!doc.exists) {
                console.error(`Category doc not found for select ID: ${categoryIdNum}`);
                bot.answerCallbackQuery(callbackQuery.id, { text: "Kategoriya topilmadi!" });
                return;
            }
            const categoryData = doc.data();

            const productsSnapshot = await db.collection('products').where('category', '==', categoryData.name).get();
            if (productsSnapshot.empty) {
                bot.editMessageText(`"${categoryData.name}" kategoriyasida hech qanday mahsulot yo'q. Boshqa kategoriyani tanlang.`, { 
                    chat_id: chatId, message_id: callbackQuery.message.message_id, parse_mode: 'Markdown'
                });
                bot.answerCallbackQuery(callbackQuery.id, { text: "Mahsulotlar yo'q." });
                return;
            }

            const products = productsSnapshot.docs.map(pDoc => {
                const pData = pDoc.data();
                return { id: pData.id, name: pData.name };
            });

            const inlineKeyboard = { reply_markup: { inline_keyboard: [] } };

            for (let i = 0; i < products.length; i += 2) {
                const row = [{ text: products[i].name, callback_data: `update_product_${products[i].id}` }];
                if (i + 1 < products.length) {
                    row.push({ text: products[i + 1].name, callback_data: `update_product_${products[i + 1].id}` });
                }
                inlineKeyboard.reply_markup.inline_keyboard.push(row);
            }
            inlineKeyboard.reply_markup.inline_keyboard.push([{ text: "⬅️ Orqaga", callback_data: 'update_cancel' }]);
            
            bot.editMessageText(`"${categoryData.name}" kategoriyasidagi mahsulotlar:\n\nQaysi mahsulotni yangilashni xohlaysiz?`, { 
                chat_id: chatId, message_id: callbackQuery.message.message_id, 
                reply_markup: inlineKeyboard.reply_markup, parse_mode: 'Markdown'
            });
            bot.answerCallbackQuery(callbackQuery.id, { text: "Kategoriya tanlandi! Mahsulot tanlang." });
        } catch (error) {
            console.error("Kategoriya mahsulotlarini olishda xato:", error);
            bot.answerCallbackQuery(callbackQuery.id, { text: "Xato yuz berdi!" });
        }
        return;
    }

    // Mahsulot tanlash va yangilash maydonini tanlash (priceBox olib tashlandi)
    if (data.startsWith('update_product_')) {
        const productIdStr = data.replace('update_product_', '');
        console.log(`Extracted product ID: ${productIdStr}`);
        const productIdNum = parseInt(productIdStr);
        if (isNaN(productIdNum)) {
            console.error(`Invalid product ID: ${productIdStr}`);
            bot.answerCallbackQuery(callbackQuery.id, { text: "Noto'g'ri mahsulot ID!" });
            return;
        }
        console.log(`Parsed product ID: ${productIdNum}`);
        try {
            const doc = await db.collection('products').doc(String(productIdNum)).get();
            console.log(`Product doc exists: ${doc.exists}`);
            if (!doc.exists) {
                console.error(`Product doc not found for ID: ${productIdNum}`);
                bot.answerCallbackQuery(callbackQuery.id, { text: "Mahsulot topilmadi!" });
                return;
            }

            const productData = doc.data();
            console.log(`Product data:`, productData);
            resetUserState(chatId);
            userState[chatId] = { 
                step: 'update_field', 
                data: { id: productIdNum, product: productData }, 
                steps: []
            };

            const updateKeyboard = {
                reply_markup: {
                    inline_keyboard: [
                        [{ text: `Nomi: ${productData.name}`, callback_data: `update_field_name_${productIdNum}` }],
                        [{ text: `Dona narxi: ${productData.pricePiece.toFixed(2)} $`, callback_data: `update_field_pricePiece_${productIdNum}` }],
                        [{ text: `Chegirma: ${productData.discount}%`, callback_data: `update_field_discount_${productIdNum}` }],
                        [{ text: `Stock: ${productData.stock.toLocaleString()} dona`, callback_data: `update_field_stock_${productIdNum}` }],
                        [{ text: `Karobka sig'imi: ${productData.boxCapacity} dona`, callback_data: `update_field_boxCapacity_${productIdNum}` }],
                        [{ text: `Tavsif: ${productData.description ? productData.description.substring(0, 20) + '...' : 'Yo\'q'}`, callback_data: `update_field_description_${productIdNum}` }],
                        [{ text: `Rasm: ${productData.image ? 'Bor' : 'Yo\'q'}`, callback_data: `update_field_image_${productIdNum}` }],
                        [{ text: "🗑 Mahsulotni o'chirish", callback_data: `delete_product_${productIdNum}` }],
                        [{ text: "⬅️ Orqaga", callback_data: 'update_cancel' }]
                    ],
                },
            };

            const message = `📝 **Mahsulot:** ${productData.name} (ID: ${productIdNum})\n\n` +
                            `Hozirgi qiymatlar:\n` +
                            `• **Nomi:** ${productData.name}\n` +
                            `• **Dona narxi:** ${productData.pricePiece.toFixed(2)} $\n` +
                            `• **Chegirma:** ${productData.discount}%\n` +
                            `• **Stock:** ${productData.stock.toLocaleString()} dona\n` +
                            `• **Karobka sig'imi:** ${productData.boxCapacity} dona\n` +
                            `• **Tavsif:** ${productData.description || 'Belgilanmagan'}\n` +
                            `• **Rasm:** ${productData.image ? 'URL mavjud' : 'Yo\'q'}\n\n` +
                            `Qaysi maydonni yangilashni xohlaysiz? (Tugmani bosing)`;

            bot.editMessageText(message, { 
                chat_id: chatId, message_id: callbackQuery.message.message_id, 
                reply_markup: updateKeyboard.reply_markup, parse_mode: 'Markdown'
            });
            bot.answerCallbackQuery(callbackQuery.id, { text: "Mahsulot tanlandi! Endi maydon tanlang." });
        } catch (error) {
            console.error("Mahsulotni tanlashda xato:", error);
            bot.answerCallbackQuery(callbackQuery.id, { text: "Xato yuz berdi!" });
        }
        return;
    }

    if (data.startsWith('update_field_')) {
        const parts = data.split('_');
        const fieldType = parts[2];
        const productIdStr = parts[3];
        console.log(`Extracted product ID for field update: ${productIdStr}`);
        const productIdNum = parseInt(productIdStr);
        if (isNaN(productIdNum)) {
            console.error(`Invalid product ID for field update: ${productIdStr}`);
            bot.answerCallbackQuery(callbackQuery.id, { text: "Noto'g'ri mahsulot ID!" });
            return;
        }
        console.log(`Parsed product ID for field update: ${productIdNum}`);

        const fieldMap = {
            'name': 'Mahsulot nomi (matn)',
            'pricePiece': 'Dona narxi (faqat musbat son, USD, masalan: 5.50)',
            'discount': 'Chegirma (0 dan 100 gacha son)',
            'stock': 'Stock (0 yoki musbat son)',
            'boxCapacity': 'Karobka sig\'imi (musbat son)',
            'description': 'Tavsif (matn)',
            'image': 'Rasm (photo yuboring)'
        };
        const fieldName = fieldMap[fieldType];

        if (!fieldName) {
            bot.answerCallbackQuery(callbackQuery.id, { text: "Noto'g'ri maydon!" });
            return;
        }

        if (fieldType === 'name') {
            userState[chatId] = { step: 'update_product_name', data: { id: productIdNum }, steps: [] };
            bot.editMessageText(`**Yangi mahsulot nomi** ni kiriting:`, { 
                chat_id: chatId, message_id: callbackQuery.message.message_id, parse_mode: 'Markdown', reply_markup: backKeyboard.reply_markup
            });
        } else if (fieldType === 'description') {
            userState[chatId] = { step: 'update_product_description', data: { id: productIdNum }, steps: [] };
            bot.editMessageText(`**Yangi tavsif** ni kiriting:`, { 
                chat_id: chatId, message_id: callbackQuery.message.message_id, parse_mode: 'Markdown', reply_markup: backKeyboard.reply_markup
            });
        } else if (fieldType === 'image') {
            userState[chatId] = { step: 'update_product_image', data: { id: productIdNum }, steps: [] };
            bot.editMessageText('**Yangi rasm** yuboring (photo formatida):', { 
                chat_id: chatId, message_id: callbackQuery.message.message_id, parse_mode: 'Markdown', reply_markup: mainBackKeyboard.reply_markup
            });
        } else {
            userState[chatId] = { step: 'update_value', data: { id: productIdNum, field: fieldType }, steps: [] };
            bot.editMessageText(`**${fieldName}** uchun yangi qiymatni yuboring:`, { 
                chat_id: chatId, message_id: callbackQuery.message.message_id, parse_mode: 'Markdown', reply_markup: backKeyboard.reply_markup
            });
        }
        bot.answerCallbackQuery(callbackQuery.id, { text: `${fieldName} tanlandi! Endi qiymat yuboring.` });
        return;
    }

    // Mahsulot o'chirish
    if (data.startsWith('delete_product_')) {
        const productIdStr = data.replace('delete_product_', '');
        console.log(`Extracted product ID for delete: ${productIdStr}`);
        const productIdNum = parseInt(productIdStr);
        if (isNaN(productIdNum)) {
            console.error(`Invalid product ID for delete: ${productIdStr}`);
            bot.answerCallbackQuery(callbackQuery.id, { text: "Noto'g'ri mahsulot ID!" });
            return;
        }
        console.log(`Parsed product ID for delete: ${productIdNum}`);
        try {
            const doc = await db.collection('products').doc(String(productIdNum)).get();
            console.log(`Product doc exists for delete: ${doc.exists}`);
            if (!doc.exists) {
                console.error(`Product doc not found for delete ID: ${productIdNum}`);
                bot.answerCallbackQuery(callbackQuery.id, { text: "Mahsulot topilmadi!" });
                return;
            }
            const productData = doc.data();

            await db.collection('products').doc(String(productIdNum)).delete();
            bot.editMessageText(`✅ **Mahsulot** "${productData.name}" o'chirildi.`, { 
                chat_id: chatId, message_id: callbackQuery.message.message_id, parse_mode: 'Markdown'
            });
            bot.answerCallbackQuery(callbackQuery.id, { text: "Mahsulot o'chirildi!" });
        } catch (error) {
            console.error("Mahsulot o'chirishda xato:", error);
            bot.answerCallbackQuery(callbackQuery.id, { text: "Xato yuz berdi!" });
        }
        return;
    }

    if (data === 'update_cancel') {
        resetUserState(chatId);
        bot.editMessageText("Yangilash bekor qilindi. Boshqa amalni tanlang.", { 
            chat_id: chatId, message_id: callbackQuery.message.message_id, parse_mode: 'Markdown'
        });
        bot.answerCallbackQuery(callbackQuery.id, { text: "Bekor qilindi!" });
        return;
    }
});

console.log("Bot ishga tushdi va polling boshlandi...");