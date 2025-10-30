// index.js

// 1. Kutubxonalarni chaqirish va .env ni yuklash
require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const admin = require('firebase-admin');
const axios = require('axios');
const FormData = require('form-data');
// const fs = require('fs'); // Endi serviceAccountKey.json ni o'qish uchun fs kerak emas

// 2. Maxfiy ma'lumotlarni Environment Variables (Railway) dan olish
// Eslatma: Bu yerda default qiymatlarni qoldirish faqat test uchun yaxshi.
// Asosiy deployda Railway'dan olingan haqiqiy qiymatlar ishlatiladi.
const TOKEN = process.env.TELEGRAM_BOT_TOKEN || '7586941333:AAHKly13Z3M5qkyKjP-6x-thWvXdJudIHsU';
const IMGBB_API_KEY = process.env.IMGBB_API_KEY || '38fcdca0b624f0123f15491175c8bd78';
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
const userState = {}; // Foydalanuvchi holatini (step, data) saqlash

// 4. Asosiy boshqaruv klaviaturasi (Bekor qilish tugmasi qo'shilgan)
const mainKeyboard = {
    reply_markup: {
        keyboard: [
            [{ text: "🛍 Mahsulot qo'shish" }, { text: "📂 Kategoriya qo'shish" }],
            [{ text: "🔄 Mahsulotni yangilash" }, { text: "💱 Dollar kursini o'rnatish" }],
            [{ text: "📊 Ma'lumotlarni ko'rish" }, { text: "❌ Bekor qilish" }],
        ],
        resize_keyboard: true,
    },
};

// 5. Yordamchi funksiyalar (O'zgarishsiz qoldi)
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
        return (typeof lastId === 'number' && lastId > 0) ? lastId + 1 : 1; 
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

// State'ni tozalash funksiyasi
function resetUserState(chatId) {
    userState[chatId] = { step: 'none', data: {} };
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

        userState[chatId] = { step: 'product_name', data: { categoryNames } };
        bot.sendMessage(chatId, "1/8. Mahsulot nomini kiriting:");
        return;
    }

    if (text === "📂 Kategoriya qo'shish") {
        userState[chatId] = { step: 'category_name', data: {} };
        bot.sendMessage(chatId, "1/2. Kategoriya nomini kiriting (mas: Oziq-ovqat):");
        return;
    }

    if (text === "💱 Dollar kursini o'rnatish") {
        userState[chatId] = { step: 'usd_rate' };
        bot.sendMessage(chatId, "USD to UZS kursini kiriting (masalan: 12600):");
        return;
    }
    
    // Asosiy menyuda "❌ Bekor qilish" bosilganda ham shu yerga kirishi kerak
    if (text === "❌ Bekor qilish") {
        // resetUserState yuqorida allaqachon chaqirilgan
        bot.sendMessage(chatId, "Joriy amal bekor qilindi.", mainKeyboard);
        return;
    }

    if (text === "🔄 Mahsulotni yangilash") {
        try {
            const productsSnapshot = await db.collection('products').get();
            if (productsSnapshot.empty) {
                bot.sendMessage(chatId, "Hech qanday mahsulot topilmadi. Avval qo'shing.", mainKeyboard);
                return;
            }

            const products = productsSnapshot.docs.map(doc => {
                const data = doc.data();
                return { id: data.id, name: data.name };
            });

            const inlineKeyboard = { reply_markup: { inline_keyboard: [] } };

            for (let i = 0; i < products.length; i += 2) {
                const row = [{ text: products[i].name, callback_data: `update_product_${products[i].id}` }];
                if (i + 1 < products.length) {
                    row.push({ text: products[i + 1].name, callback_data: `update_product_${products[i + 1].id}` });
                }
                inlineKeyboard.reply_markup.inline_keyboard.push(row);
            }
            
            bot.sendMessage(chatId, "Qaysi mahsulotni yangilashni xohlaysiz? (Inline tugmalardan tanlang):", inlineKeyboard);
        } catch (error) {
            console.error("Mahsulotlar olishda xato:", error);
            bot.sendMessage(chatId, "❌ Mahsulotlarni olishda xato yuz berdi!", mainKeyboard);
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


// 6. Asosiy message handler (O'zgarishsiz qoldi)
// --------------------------------------------------------------------------------------

// Tugma buyruqlarining to'liq ro'yxati
const commandButtons = [
    "🛍 Mahsulot qo'shish",
    "📂 Kategoriya qo'shish",
    "💱 Dollar kursini o'rnatish",
    "🔄 Mahsulotni yangilash",
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

    // Tugma buyruqlarini tekshirish (handleCommand ga o'tkazish)
    if (text && commandButtons.includes(text)) {
        await handleCommand(chatId, text);
        return;
    }

    // Agar photo bo'lsa, uni alohida handler'ga o'tkazamiz
    if (photo && !text) {
        return bot.emit('photo', msg);
    }

    // Joriy state'ni tekshirish (Agar foydalanuvchi ma'lumot kiritish bosqichida bo'lsa)
    if (!userState[chatId] || userState[chatId].step === 'none') {
        bot.sendMessage(chatId, "Tushunmadim. Iltimos, quyidagi tugmalardan birini tanlang:", mainKeyboard);
        return;
    }

    // --- Mahsulot qo'shish bosqichlari ---
    if (userState[chatId] && userState[chatId].step.startsWith('product_')) {
        const step = userState[chatId].step;
        let data = userState[chatId].data;

        // Xavfsizlik tekshiruvlari
        if (text && (text.startsWith('/') || commandButtons.includes(text))) {
            bot.sendMessage(chatId, "Iltimos, Buyruqlar yoki Tugmalarni emas, ma'lumot kiriting. Bekor qilish uchun ❌ Bekor qilish ni bosing.");
            return;
        }

        switch (step) {
            case 'product_name':
                data.name = text;
                userState[chatId].step = 'product_price_box';
                bot.sendMessage(chatId, "2/8. Karobka narxi (raqam, mas: 200000):");
                break;
            case 'product_price_box':
                if (!/^\d+$/.test(text) || parseInt(text) <= 0) {
                    bot.sendMessage(chatId, "Musbat son kiriting!");
                    return;
                }
                data.priceBox = parseInt(text);
                userState[chatId].step = 'product_price_piece';
                bot.sendMessage(chatId, "3/8. Dona narxi (raqam, mas: 500):");
                break;
            case 'product_price_piece':
                if (!/^\d+$/.test(text) || parseInt(text) <= 0) {
                    bot.sendMessage(chatId, "Musbat son kiriting!");
                    return;
                }
                data.pricePiece = parseInt(text);
                userState[chatId].step = 'product_discount';
                bot.sendMessage(chatId, "4/8. Chegirma (0-100, mas: 10):");
                break;
            case 'product_discount':
                if (!/^\d+$/.test(text) || parseInt(text) < 0 || parseInt(text) > 100) {
                    bot.sendMessage(chatId, "0 dan 100 gacha son kiriting!");
                    return;
                }
                data.discount = parseInt(text);
                userState[chatId].step = 'product_category';
                // Kategoriyalarni bir qatorda ko'rsatish
                const categoryKeyboard = { 
                    reply_markup: { 
                        keyboard: [data.categoryNames.map(name => ({ text: name }))], 
                        resize_keyboard: true, 
                        one_time_keyboard: true 
                    } 
                };
                bot.sendMessage(chatId, "5/8. Kategoriyani tanlang:", categoryKeyboard);
                break;
            case 'product_category':
                if (!data.categoryNames.includes(text)) {
                    bot.sendMessage(chatId, "Iltimos, kategoriyani tugmalardan tanlang!");
                    return;
                }
                data.category = text;
                userState[chatId].step = 'product_image';
                // Keyinroq rasm kelishini kutish uchun Asosiy menyuni ko'rsatish
                bot.sendMessage(chatId, "6/8. Rasm yuboring (photo formatida):", mainKeyboard); 
                break;
            case 'product_image':
                // Bu yerga faqat text kelsa kiradi, shuning uchun photo kelishini kutish kerak
                if (!photo) {
                    bot.sendMessage(chatId, "Iltimos, rasm yuboring!");
                }
                return;
            case 'product_description':
                data.description = text;
                userState[chatId].step = 'product_box_capacity';
                bot.sendMessage(chatId, "7/8. Har bir karobkada necha dona bor (raqam, mas: 20):");
                break;
            case 'product_box_capacity':
                if (!/^\d+$/.test(text) || parseInt(text) <= 0) {
                    bot.sendMessage(chatId, "Musbat son kiriting!");
                    return;
                }
                data.boxCapacity = parseInt(text);
                userState[chatId].step = 'product_stock';
                bot.sendMessage(chatId, "8/8. Ombordagi jami stock (dona soni, mas: 100):");
                break;
            case 'product_stock':
                if (!/^\d+$/.test(text) || parseInt(text) < 0) {
                    bot.sendMessage(chatId, "0 yoki musbat son kiriting!");
                    return;
                }
                data.stock = parseInt(text);

                // Yangi mahsulotni saqlash
                const newId = await getNextId('products');
                if (newId === -1) {
                    bot.sendMessage(chatId, "❌ Mahsulot ID sini olishda xato yuz berdi!", mainKeyboard);
                    resetUserState(chatId);
                    return;
                }
                
                const newProduct = {
                    id: newId,
                    name: data.name,
                    priceBox: data.priceBox,
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
                        `**Karobka narxi:** ${newProduct.priceBox.toLocaleString()} so'm\n` +
                        `**Dona narxi:** ${newProduct.pricePiece.toLocaleString()} so'm\n` +
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
        userState[chatId].data = data;
        return;
    }

    // --- Kategoriya qo'shish bosqichlari ---
    if (userState[chatId] && userState[chatId].step.startsWith('category_')) {
        const step = userState[chatId].step;
        let data = userState[chatId].data;

        if (text && (text.startsWith('/') || commandButtons.includes(text))) {
            bot.sendMessage(chatId, "Iltimos, ma'lumot kiriting. Bekor qilish uchun ❌ Bekor qilish ni bosing.");
            return;
        }

        switch (step) {
            case 'category_name':
                data.name = text;
                userState[chatId].step = 'category_icon';
                bot.sendMessage(chatId, "2/2. Ikonka (emoji, mas: 🥄):");
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
        userState[chatId].data = data;
        return;
    }

    // --- Dollar kursi o'rnatish bosqichi ---
    if (userState[chatId] && userState[chatId].step === 'usd_rate') {
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

    // --- Yangi qiymatni qabul qilish bosqichi (update_value) ---
    if (userState[chatId] && userState[chatId].step === 'update_value') {
        const stateData = userState[chatId].data;
        let value;
        let fieldType = stateData.field;
        let fieldNameUz;

        // Qiymatni tekshirish va o'zlashtirish
        if (fieldType.includes('price') || fieldType === 'stock' || fieldType === 'boxCapacity' || fieldType === 'discount') {
            
            const isDiscount = fieldType === 'discount';
            const isStockOrCapacity = fieldType === 'stock' || fieldType === 'boxCapacity';
            
            if (isDiscount) {
                fieldNameUz = 'Chegirma';
                if (!/^\d+$/.test(text) || parseInt(text) < 0 || parseInt(text) > 100) {
                    bot.sendMessage(chatId, "Iltimos, Chegirma uchun 0-100 orasida son kiriting!");
                    return;
                }
            } else if (isStockOrCapacity) {
                fieldNameUz = fieldType === 'stock' ? 'Stock' : 'Karobkadagi dona soni';
                 if (!/^\d+$/.test(text) || parseInt(text) < 0) {
                    bot.sendMessage(chatId, `Iltimos, ${fieldNameUz} uchun 0 yoki musbat son kiriting!`);
                    return;
                }
            } else {
                fieldNameUz = fieldType === 'priceBox' ? 'Karobka narxi' : 'Dona narxi';
                if (!/^\d+$/.test(text) || parseInt(text) <= 0) {
                    bot.sendMessage(chatId, `${fieldNameUz} uchun musbat son kiriting!`);
                    return;
                }
            }
            value = parseInt(text);

        } else {
            bot.sendMessage(chatId, "Noto'g'ri maydon aniqlandi!");
            resetUserState(chatId);
            return;
        }
        
        try {
            await db.collection('products').doc(String(stateData.id)).update({ [fieldType]: value });
            bot.sendMessage(chatId, 
                `✅ **${fieldNameUz}** yangilandi: **${value.toLocaleString()}** ${fieldType === 'discount' ? '%' : 'so\'m/dona'}\n\n` +
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

    // Noma'lum holat
    bot.sendMessage(chatId, "Tushunmadim. Iltimos, quyidagi tugmalardan birini tanlang:", mainKeyboard);
});

// 7. Photo handler (rasm yuklash uchun)
// --------------------------------------------------------------------------------------

bot.on('photo', async (msg) => {
    const chatId = msg.chat.id;
    const fileId = msg.photo[msg.photo.length - 1].file_id; // Eng yuqori sifatdagi rasm

    if (!admins.includes(chatId)) return;
    
    // Agar db ulanmagan bo'lsa, xabar berish
    if (!db) {
        bot.sendMessage(chatId, "❌ Uzr, Database ulanishi yo'q. Avval Railway Variables ni tekshiring.");
        return;
    }

    if (userState[chatId] && userState[chatId].step === 'product_image') {
        let data = userState[chatId].data;

        // Foydalanuvchiga kutish haqida xabar berish
        const waitMessage = await bot.sendMessage(chatId, "Rasm yuklanmoqda... ⏳");

        const imageUrl = await uploadToImgBB(fileId);
        if (imageUrl) {
            data.image = imageUrl;
            userState[chatId].step = 'product_description';
            // Rasm muvaffaqiyatli yuklangandan so'ng asosiy menyu tugmasi yashirinib, keyingi bosqich so'raladi
            await bot.editMessageText(`✅ Rasm yuklandi: ${imageUrl.substring(0, 50)}...\n\n7/8. Tavsif (qisqa ma'lumot):`, {
                chat_id: chatId,
                message_id: waitMessage.message_id
            });
            // mainKeyboard ni yubormaslik kerak, chunki u photo dan keyin yuborilgan waitMessage ni tahrirlaydi
        } else {
            bot.editMessageText("❌ Rasm yuklashda xato yuz berdi! Qaytadan urinib ko'ring.", {
                chat_id: chatId,
                message_id: waitMessage.message_id
            });
            // Xato bo'lsa, bosqichni o'zgartirmaymiz, foydalanuvchi qayta urinishi yoki bekor qilishi mumkin
        }
        userState[chatId].data = data;
    } else {
        bot.sendMessage(chatId, "Hozir rasm kutilyapti emas. Tugmalardan foydalaning.", mainKeyboard);
    }
});

// 8. Callback query handler (inline tugmalar uchun) (O'zgarishsiz qoldi)
// --------------------------------------------------------------------------------------

bot.on('callback_query', async (callbackQuery) => {
    const chatId = callbackQuery.message.chat.id;
    const data = callbackQuery.data;

    if (!data || !admins.includes(chatId)) {
        bot.answerCallbackQuery(callbackQuery.id, { text: "Ruxsat yo'q!" });
        return;
    }
    
    // Agar db ulanmagan bo'lsa, xabar berish
    if (!db) {
        bot.answerCallbackQuery(callbackQuery.id, { text: "Database ulanishi yo'q. Tekshiring." });
        return;
    }
    
    // ... Mahsulot tanlash va yangilash maydonini tanlash qismi to'g'ri yozilgan
    if (data.startsWith('update_product_')) {
        // (Mahsulot tanlandi)
        const productId = parseInt(data.replace('update_product_', ''));
        try {
            const doc = await db.collection('products').doc(String(productId)).get();
            if (!doc.exists) {
                bot.answerCallbackQuery(callbackQuery.id, { text: "Mahsulot topilmadi!" });
                return;
            }

            const productData = doc.data();
            resetUserState(chatId); // State'ni tozalash
            userState[chatId] = { 
                step: 'update_field', 
                data: { id: productId, product: productData } 
            };

            const updateKeyboard = {
                reply_markup: {
                    inline_keyboard: [
                        [{ text: `Karobka narxi: ${productData.priceBox.toLocaleString()} so'm`, callback_data: `update_field_priceBox_${productId}` }],
                        [{ text: `Dona narxi: ${productData.pricePiece.toLocaleString()} so'm`, callback_data: `update_field_pricePiece_${productId}` }],
                        [{ text: `Chegirma: ${productData.discount}%`, callback_data: `update_field_discount_${productId}` }],
                        [{ text: `Stock: ${productData.stock.toLocaleString()} dona`, callback_data: `update_field_stock_${productId}` }],
                        [{ text: "❌ Bekor qilish", callback_data: 'update_cancel' }]
                    ],
                },
            };

            const message = `📝 **Mahsulot:** ${productData.name} (ID: ${productId})\n\n` +
                            `Hozirgi qiymatlar:\n` +
                            `• **Karobka narxi:** ${productData.priceBox.toLocaleString()} so'm\n` +
                            `• **Dona narxi:** ${productData.pricePiece.toLocaleString()} so'm\n` +
                            `• **Chegirma:** ${productData.discount}%\n` +
                            `• **Stock:** ${productData.stock.toLocaleString()} dona\n\n` +
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
        // (Yangilash maydoni tanlandi)
        const parts = data.split('_');
        const fieldType = parts[2];
        const productId = parseInt(parts[3]);

        const fieldMap = {
            'priceBox': 'Karobka narxi (faqat musbat son)',
            'pricePiece': 'Dona narxi (faqat musbat son)',
            'discount': 'Chegirma (0 dan 100 gacha son)',
            'stock': 'Stock (0 yoki musbat son)',
            'boxCapacity': 'Karobkadagi dona soni (faqat musbat son)'
        };
        const fieldName = fieldMap[fieldType];

        if (!fieldName) {
            bot.answerCallbackQuery(callbackQuery.id, { text: "Noto'g'ri maydon!" });
            return;
        }
        
        // update_value bosqichiga o'tkazish
        userState[chatId] = { step: 'update_value', data: { id: productId, field: fieldType } };

        bot.editMessageText(`**${fieldName}** uchun yangi qiymatni yuboring:`, { 
            chat_id: chatId, message_id: callbackQuery.message.message_id, parse_mode: 'Markdown'
        });
        bot.answerCallbackQuery(callbackQuery.id, { text: `${fieldName} tanlandi! Endi qiymat yuboring.` });
        return;
    }

    if (data === 'update_cancel') {
        // (Bekor qilish buyrug'i)
        resetUserState(chatId);
        bot.editMessageText("Yangilash bekor qilindi. Boshqa amalni tanlang.", { 
            chat_id: chatId, message_id: callbackQuery.message.message_id, parse_mode: 'Markdown'
        });
        bot.answerCallbackQuery(callbackQuery.id, { text: "Bekor qilindi!" });
        return;
    }
});

console.log("Bot ishga tushdi va polling boshlandi...");