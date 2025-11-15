// index.js
// 1. Kutubxonalarni chaqirish va .env ni yuklash
require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const admin = require('firebase-admin');
const axios = require('axios');
const FormData = require('form-data');

// 2. Maxfiy ma'lumotlarni Environment Variables (Railway) dan olish
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
        throw new Error("FIREBASE_SERVICE_ACCOUNT_JSON topilmadi. Variables bo'limini tekshiring.");
    }
    // 2. JSON stringni JS obyektiga aylantirish
    const serviceAccount = JSON.parse(serviceAccountJson);

    // 3. Firebase'ni sozlash
    admin.initializeApp({
        credential: admin.credential.cert(serviceAccount),
        databaseURL: "https://oscar-d85af.firebaseio.com"
    });
    db = admin.firestore();
    console.log("✅ Firebase muvaffaqiyatli ulangan.");
} catch (error) {
    console.error("❌ Firebase sozlashda KRITIK XATO!", error.message);
}

const bot = new TelegramBot(TOKEN, { polling: true });

const userState = {}; // Foydalanuvchi holatini saqlash

// 4. Asosiy boshqaruv klaviaturasi
const mainKeyboard = {
    reply_markup: {
        keyboard: [
            [{ text: "🛍 Mahsulot qo'shish" }, { text: "📂 Kategoriya qo'shish" }],
            [{ text: "📂 Kategoriya yangilash" }, { text: "🔄 Mahsulotni yangilash" }],
            [{ text: "📊 Ma'lumotlarni ko'rish" }, { text: "❌ Bekor qilish" }],
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
            ...mainKeyboard.reply_markup.keyboard.slice(0, -1),
            [{ text: "❌ Bekor qilish" }, { text: "Orqaga" }]
        ],
        resize_keyboard: true,
    },
};

// 5. Yordamchi funksiyalar
// --------------------------------------------------------------------------------------
async function getNextId(collectionName) {
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

function resetUserState(chatId) {
    userState[chatId] = { step: 'none', data: {}, steps: [] };
}

// TUZATILGAN: Orqaga qaytish handler - Mahsulot yangilash jarayonida ham to'g'ri ishlaydi
async function handleBack(chatId) {
    const state = userState[chatId];
    if (!state || state.steps.length === 0) {
        resetUserState(chatId);
        bot.sendMessage(chatId, "Bosh menyu.", mainKeyboard);
        return;
    }
    const prevStep = state.steps.pop();
    state.step = prevStep;
    console.log(`Orqaga qaytildi: ${prevStep}, qolgan qadamlar: ${state.steps.length}`);

    // Mahsulot yangilash jarayonidagi qadamlar uchun
    if (prevStep === 'product_update_view') {
        await showProductView(chatId, state.data.productId, state.data.messageId);
    } else if (prevStep === 'product_update_product_select') {
        const categoryName = state.data.selectedCategory;
        if (categoryName) {
            await showProductsInCategory(chatId, categoryName, state.data.messageId);
        } else {
            // Agar categoryName saqlanmagan bo'lsa, kategoriyalarni tanlashga qaytish mantiqsiz, shuning uchun bekor qilish
            resetUserState(chatId);
            bot.sendMessage(chatId, "Jarayon bekor qilindi. Bosh menyu.", mainKeyboard);
        }
    } else if (prevStep === 'product_update_category_select') {
         // Agar inline menyudan foydalangan bo'lsak, editMessageText kerak
         const lastMessageId = state.data.lastInlineMessageId || state.data.messageId; // Foydalanish tartibiga qarab
         if (lastMessageId) {
             bot.editMessageText("Mahsulot yangilash bekor qilindi. Bosh menyu.", {
                 chat_id: chatId,
                 message_id: lastMessageId,
                 parse_mode: 'Markdown'
             });
         }
         resetUserState(chatId);
         bot.sendMessage(chatId, "Bosh menyu.", mainKeyboard);
    } else if (prevStep === 'update_product_name' ||
               prevStep === 'update_product_description' ||
               prevStep === 'update_product_image' ||
               prevStep === 'update_value') {
        // Agar foydalanuvchi kirish jarayonida "Orqaga" bostaysa, bu ham o'zgartirish menyusiga qaytadi
        await showProductView(chatId, state.data.productId, state.data.messageId);
    }
    // Kategoriya yangilash jarayonidagi qadamlar uchun
     else if (prevStep === 'category_update_view') {
        await showCategoryView(chatId, state.data.categoryId, state.data.messageId);
    } else if (prevStep === 'category_update_select') {
         const lastMessageId = state.data.lastInlineMessageId || state.data.messageId;
         if (lastMessageId) {
             bot.editMessageText("Kategoriya yangilash bekor qilindi. Bosh menyu.", {
                 chat_id: chatId,
                 message_id: lastMessageId,
                 parse_mode: 'Markdown'
             });
         }
         resetUserState(chatId);
         bot.sendMessage(chatId, "Bosh menyu.", mainKeyboard);
    } else if (prevStep === 'update_category_name' ||
               prevStep === 'update_category_icon') {
        await showCategoryView(chatId, state.data.categoryId, state.data.messageId);
    }
    // Mahsulot qo'shish jarayoni uchun
    else if (prevStep.startsWith('product_')) {
        await handleProductStep(chatId, prevStep, true);
    }
    // Kategoriya qo'shish jarayoni uchun
    else if (prevStep.startsWith('category_')) {
        await handleCategoryStep(chatId, prevStep, true);
    }
    else {
        // Agar boshqa qadam bo'lsa hammasi bekor qilinsin
        resetUserState(chatId);
        bot.sendMessage(chatId, "Bosh menyu.", mainKeyboard);
    }
}

// TUZATILGAN: Inline orqaga handler - asl holatda saqlangan messageId dan foydalanadi
async function handleInlineBack(chatId, messageId) {
    const state = userState[chatId];
    if (!state || state.steps.length === 0) {
        resetUserState(chatId);
        bot.editMessageText("Yangilash bekor qilindi. Bosh menyu.", {
            chat_id: chatId,
            message_id: messageId,
            parse_mode: 'Markdown'
        });
        bot.sendMessage(chatId, "Bosh menyu.", mainKeyboard);
        return;
    }
    const prevStep = state.steps.pop();
    state.step = prevStep;
    console.log(`Inline orqaga qaytildi: ${prevStep}, qolgan qadamlar: ${state.steps.length}`);

    if (prevStep === 'category_update_select') {
        await showCategoryUpdateSelect(chatId, messageId);
    } else if (prevStep === 'product_update_category_select') {
        await showProductUpdateCategorySelect(chatId, messageId);
    } else if (prevStep === 'product_update_product_select') {
        const categoryName = state.data.selectedCategory;
        if (categoryName) {
            await showProductsInCategory(chatId, categoryName, messageId);
        } else {
            await showProductUpdateCategorySelect(chatId, messageId);
        }
    } else if (prevStep === 'category_update_view') {
        await showCategoryView(chatId, state.data.categoryId, messageId);
    } else if (prevStep === 'product_update_view') {
        await showProductView(chatId, state.data.productId, messageId);
    } else {
        // Boshqa hollarda hammasi bekor qilinsin
        resetUserState(chatId);
        bot.editMessageText("Yangilash bekor qilindi. Bosh menyu.", {
            chat_id: chatId,
            message_id: messageId,
            parse_mode: 'Markdown'
        });
        bot.sendMessage(chatId, "Bosh menyu.", mainKeyboard);
    }
}

// Kategoriya view ko'rsatish
async function showCategoryView(chatId, categoryId, messageId) {
    try {
        const doc = await db.collection('categories').doc(String(categoryId)).get();
        if (!doc.exists) {
            if (messageId) {
                bot.editMessageText("Kategoriya topilmadi!", { chat_id: chatId, message_id: messageId });
            }
            bot.sendMessage(chatId, "Bosh menyu.", mainKeyboard);
            return;
        }
        const categoryData = doc.data();
        const updateKeyboard = {
            reply_markup: {
                inline_keyboard: [
                    [{ text: `Nomi: ${categoryData.name}`, callback_data: `cat_update_name_${categoryId}` }],
                    [{ text: `Ikonka: ${categoryData.icon}`, callback_data: `cat_update_icon_${categoryId}` }],
                    [{ text: "🗑 Kategoriyani o'chirish", callback_data: `delete_category_${categoryId}` }],
                    [{ text: "⬅️ Orqaga", callback_data: 'back_to_prev' }]
                ],
            },
        };
        const message = `📝 Kategoriya: ${categoryData.icon} ${categoryData.name} (ID: ${categoryId})
` +
                        `Hozirgi qiymatlar:
` +
                        `• Nomi: ${categoryData.name}
` +
                        `• Ikonka: ${categoryData.icon}
` +
                        `Nima o'zgartirishni xohlaysiz? (Tugmani bosing)`;
        if (messageId) {
            bot.editMessageText(message, {
                chat_id: chatId, message_id: messageId,
                reply_markup: updateKeyboard.reply_markup, parse_mode: 'Markdown'
            });
        } else {
            bot.sendMessage(chatId, message, updateKeyboard);
        }
    } catch (error) {
        console.error("Kategoriya view ko'rsatishda xato:", error);
        if (messageId) {
            bot.editMessageText("Xato yuz berdi!", { chat_id: chatId, message_id: messageId });
        }
        bot.sendMessage(chatId, "Bosh menyu.", mainKeyboard);
    }
}

// Mahsulot view ko'rsatish
async function showProductView(chatId, productId, messageId) {
    try {
        const doc = await db.collection('products').doc(String(productId)).get();
        if (!doc.exists) {
            if (messageId) {
                bot.editMessageText("Mahsulot topilmadi!", { chat_id: chatId, message_id: messageId });
            }
            bot.sendMessage(chatId, "Bosh menyu.", mainKeyboard);
            return;
        }
        const productData = doc.data();
        const updateKeyboard = {
            reply_markup: {
                inline_keyboard: [
                    [{ text: `Nomi: ${productData.name}`, callback_data: `update_field_name_${productId}` }],
                    [{ text: `Dona narxi: ${productData.pricePiece.toFixed(2)} $`, callback_data: `update_field_pricePiece_${productId}` }],
                    [{ text: `Chegirma: ${productData.discount}%`, callback_data: `update_field_discount_${productId}` }],
                    [{ text: `Stock: ${productData.stock.toLocaleString()} dona`, callback_data: `update_field_stock_${productId}` }],
                    [{ text: `Karobka sig'imi: ${productData.boxCapacity} dona`, callback_data: `update_field_boxCapacity_${productId}` }],
                    [{ text: `Tavsif: ${productData.description ? productData.description.substring(0, 20) + '...' : 'Yo\'q'}`, callback_data: `update_field_description_${productId}` }],
                    [{ text: `Rasm: ${productData.image ? 'Bor' : 'Yo\'q'}`, callback_data: `update_field_image_${productId}` }],
                    [{ text: "🗑 Mahsulotni o'chirish", callback_data: `delete_product_${productId}` }],
                    [{ text: "⬅️ Orqaga", callback_data: 'back_to_prev' }]
                ],
            },
        };
        const message = `📝 Mahsulot: ${productData.name} (ID: ${productId})
` +
                        `Hozirgi qiymatlar:
` +
                        `• Nomi: ${productData.name}
` +
                        `• Dona narxi: ${productData.pricePiece.toFixed(2)} $
` +
                        `• Chegirma: ${productData.discount}%
` +
                        `• Stock: ${productData.stock.toLocaleString()} dona
` +
                        `• Karobka sig'imi: ${productData.boxCapacity} dona
` +
                        `• Tavsif: ${productData.description || 'Belgilanmagan'}
` +
                        `• Rasm: ${productData.image ? 'URL mavjud' : 'Yo\'q'}
` +
                        `Qaysi maydonni yangilashni xohlaysiz? (Tugmani bosing)`;
        if (messageId) {
            bot.editMessageText(message, {
                chat_id: chatId, message_id: messageId,
                reply_markup: updateKeyboard.reply_markup, parse_mode: 'Markdown'
            });
        } else {
            bot.sendMessage(chatId, message, updateKeyboard);
        }
    } catch (error) {
        console.error("Mahsulot view ko'rsatishda xato:", error);
        if (messageId) {
            bot.editMessageText("Xato yuz berdi!", { chat_id: chatId, message_id: messageId });
        }
        bot.sendMessage(chatId, "Bosh menyu.", mainKeyboard);
    }
}

// Kategoriya yangilash uchun kategoriya tanlash menyusini ko'rsatish
async function showCategoryUpdateSelect(chatId, messageId = null) {
    try {
        const categoriesSnapshot = await db.collection('categories').get();
        if (categoriesSnapshot.empty) {
            const text = "Hech qanday kategoriya topilmadi. Avval qo'shing.";
            if (messageId) {
                bot.editMessageText(text, { chat_id: chatId, message_id: messageId });
                bot.sendMessage(chatId, "Bosh menyu.", mainKeyboard);
            } else {
                bot.sendMessage(chatId, text, mainKeyboard);
            }
            return;
        }
        const categories = categoriesSnapshot.docs.map(doc => {
            const data = doc.data();
            return { id: data.id, name: data.name, icon: data.icon };
        });

        const inlineKeyboard = { reply_markup: { inline_keyboard: [] } };
        for (let i = 0; i < categories.length; i += 2) {
            const row = [{ text: `${categories[i].icon} ${categories[i].name}`, callback_data: `cat_select_${categories[i].id}` }];
            if (i + 1 < categories.length) {
                row.push({ text: `${categories[i + 1].icon} ${categories[i + 1].name}`, callback_data: `cat_select_${categories[i + 1].id}` });
            }
            inlineKeyboard.reply_markup.inline_keyboard.push(row);
        }
        const text = "Qaysi kategoriyani yangilashni xohlaysiz? (Inline tugmalardan tanlang):";
        if (messageId) {
            bot.editMessageText(text, { chat_id: chatId, message_id: messageId, reply_markup: inlineKeyboard.reply_markup });
        } else {
            bot.sendMessage(chatId, text, inlineKeyboard);
        }
    } catch (error) {
        console.error("Kategoriyalarni olishda xato:", error);
        const errorText = "❌ Kategoriyalarni olishda xato yuz berdi!";
        if (messageId) {
            bot.editMessageText(errorText, { chat_id: chatId, message_id: messageId });
            bot.sendMessage(chatId, "Bosh menyu.", mainKeyboard);
        } else {
            bot.sendMessage(chatId, errorText, mainKeyboard);
        }
    }
}

// Mahsulot yangilash uchun kategoriya tanlash menyusini ko'rsatish
async function showProductUpdateCategorySelect(chatId, messageId = null) {
    try {
        const categoriesSnapshot = await db.collection('categories').get();
        if (categoriesSnapshot.empty) {
            const text = "Hech qanday kategoriya topilmadi. Avval qo'shing.";
            if (messageId) {
                bot.editMessageText(text, { chat_id: chatId, message_id: messageId });
                bot.sendMessage(chatId, "Bosh menyu.", mainKeyboard);
            } else {
                bot.sendMessage(chatId, text, mainKeyboard);
            }
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
        const text = "Qaysi kategoriyadagi mahsulotni yangilashni xohlaysiz? (Inline tugmalardan tanlang):";
        if (messageId) {
            bot.editMessageText(text, { chat_id: chatId, message_id: messageId, reply_markup: inlineKeyboard.reply_markup });
        } else {
            bot.sendMessage(chatId, text, inlineKeyboard);
        }
    } catch (error) {
        console.error("Kategoriyalarni olishda xato:", error);
        const errorText = "❌ Kategoriyalarni olishda xato yuz berdi!";
        if (messageId) {
            bot.editMessageText(errorText, { chat_id: chatId, message_id: messageId });
            bot.sendMessage(chatId, "Bosh menyu.", mainKeyboard);
        } else {
            bot.sendMessage(chatId, errorText, mainKeyboard);
        }
    }
}

// TUZATILGAN: Kategoriya bo'yicha mahsulotlarni ko'rsatish
async function showProductsInCategory(chatId, categoryName, messageId = null) {
    try {
        const productsSnapshot = await db.collection('products').where('category', '==', categoryName).get();
        if (productsSnapshot.empty) {
            const text = `"${categoryName}" kategoriyasida hech qanday mahsulot yo'q.`;
            if (messageId) {
                bot.editMessageText(text, { chat_id: chatId, message_id: messageId });
                // Agar mahsulotlar bo'lmasa ham, yana kategoriyalarni tanlash menyusiga qaytish kerak emas, bekor qilish kerak
                // Shuning uchun tepada qo'shimcha setTimeout olib tashlandi
            }
            bot.sendMessage(chatId, text, mainKeyboard);
            resetUserState(chatId); // Bo'sh kategoriyada bekor qilish kerak
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
        inlineKeyboard.reply_markup.inline_keyboard.push([{ text: "⬅️ Orqaga", callback_data: 'back_to_prev' }]);

        const text = `"${categoryName}" kategoriyasidagi mahsulotlar:
Qaysi mahsulotni yangilashni xohlaysiz?`;
        if (messageId) {
            bot.editMessageText(text, {
                chat_id: chatId, message_id: messageId,
                reply_markup: inlineKeyboard.reply_markup, parse_mode: 'Markdown'
            });
        } else {
            bot.sendMessage(chatId, text, inlineKeyboard);
        }
        const state = userState[chatId];
        if (state) {
            state.data.selectedCategory = categoryName;
        }
    } catch (error) {
        console.error("Mahsulotlarni olishda xato:", error);
        const errorText = "❌ Mahsulotlarni olishda xato yuz berdi!";
        if (messageId) {
            bot.editMessageText(errorText, { chat_id: chatId, message_id: messageId });
            bot.sendMessage(chatId, "Bosh menyu.", mainKeyboard);
        } else {
            bot.sendMessage(chatId, errorText, mainKeyboard);
        }
    }
}

// Tugma buyruqlarini qayta ishlash funksiyasi
async function handleCommand(chatId, text) {
    resetUserState(chatId);
    if (!db) {
        bot.sendMessage(chatId, "❌ Uzr, Database ulanishi xato bo'ldi. Admin sozlamalarini tekshiring.", mainKeyboard);
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
        bot.sendMessage(chatId, "1/8. Mahsulot nomini kiriting:", backKeyboard);
        return;
    }
    if (text === "📂 Kategoriya qo'shish") {
        userState[chatId] = { step: 'category_name', data: {}, steps: [] };
        bot.sendMessage(chatId, "1/2. Kategoriya nomini kiriting (mas: Oziq-ovqat):", backKeyboard);
        return;
    }
    if (text === "📂 Kategoriya yangilash") {
        userState[chatId] = { step: 'category_update_select', data: {}, steps: [] };
        await showCategoryUpdateSelect(chatId);
        return;
    }
    if (text === "❌ Bekor qilish") {
        resetUserState(chatId);
        bot.sendMessage(chatId, "Joriy amal bekor qilindi.", mainKeyboard);
        return;
    }
    if (text === "🔄 Mahsulotni yangilash") {
        userState[chatId] = { step: 'product_update_category_select', data: {}, steps: [] };
        await showProductUpdateCategorySelect(chatId);
        return;
    }
    if (text === "📊 Ma'lumotlarni ko'rish") {
        try {
            const productsSnapshot = await db.collection('products').get();
            const categoriesSnapshot = await db.collection('categories').get();
            bot.sendMessage(chatId,
                `📊 Statistika:
` +
                `🔹 Mahsulotlar soni: ${productsSnapshot.size.toLocaleString()} ta
` +
                `🔹 Kategoriyalar soni: ${categoriesSnapshot.size.toLocaleString()} ta
` +
                `Barcha ma'lumotlar Firestore (Firebase) da saqlanmoqda.`,
                { ...mainKeyboard, parse_mode: 'Markdown' }
            );
        } catch (error) {
            console.error("Statistika olishda xato:", error);
            bot.sendMessage(chatId, "❌ Ma'lumotlarni olishda xato yuz berdi!", mainKeyboard);
        }
        return;
    }
    bot.sendMessage(chatId, "Tushunmadim. Iltimos, quyidagi tugmalardan birini tanlang:", mainKeyboard);
}

// Mahsulot bosqichlarini handle qilish
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
            bot.sendMessage(chatId, "1/8. Mahsulot nomini kiriting:", backKeyboard);
            break;
        case 'product_price_piece':
            state.step = 'product_price_piece';
            bot.sendMessage(chatId, "2/8. Dona narxi (USD, raqam, mas: 5.50):", backKeyboard);
            break;
        case 'product_discount':
            state.step = 'product_discount';
            bot.sendMessage(chatId, "3/8. Chegirma (0-100, mas: 10):", backKeyboard);
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
            bot.sendMessage(chatId, "4/8. Kategoriyani tanlang:", categoryKeyboard);
            break;
        case 'product_image':
            state.step = 'product_image';
            bot.sendMessage(chatId, "5/8. Rasm yuboring (photo formatida):", mainBackKeyboard);
            break;
        case 'product_description':
            state.step = 'product_description';
            bot.sendMessage(chatId, "6/8. Tavsif (qisqa ma'lumot):", backKeyboard);
            break;
        case 'product_box_capacity':
            state.step = 'product_box_capacity';
            bot.sendMessage(chatId, "7/8. Har bir karobkada necha dona bor (raqam, mas: 20):", backKeyboard);
            break;
        case 'product_stock':
            state.step = 'product_stock';
            bot.sendMessage(chatId, "8/8. Ombordagi jami stock (dona soni, mas: 100):", backKeyboard);
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
const commandButtons = [
    "🛍 Mahsulot qo'shish",
    "📂 Kategoriya qo'shish",
    "📂 Kategoriya yangilash",
    "🔄 Mahsulotni yangilash",
    "📊 Ma'lumotlarni ko'rish",
    "❌ Bekor qilish"
];

bot.on('message', async (msg) => {
    const chatId = msg.chat.id;
    const text = msg.text;
    const photo = msg.photo;

    if (!admins.includes(chatId)) {
        bot.sendMessage(chatId, "Bu bot faqat administratorlar uchun mo'ljallangan.");
        return;
    }
    if (!db) {
        bot.sendMessage(chatId, "❌ Uzr, Database ulanishi yo'q. Avval Railway Variables ni tekshiring.");
        return;
    }
    if (text && text.startsWith('/')) {
        if (text === '/start') {
            resetUserState(chatId);
            bot.sendMessage(chatId, "Xush kelibsiz! Admin paneliga kirish uchun tugmalardan birini tanlang.", mainKeyboard);
        } else {
            bot.sendMessage(chatId, "Noma'lum buyruq. /start ni bosing.", mainKeyboard);
        }
        return;
    }
    if (text === "Orqaga") {
        await handleBack(chatId);
        return;
    }
    if (text && commandButtons.includes(text)) {
        await handleCommand(chatId, text);
        return;
    }
    if (photo && !text) {
        return bot.emit('photo', msg);
    }
    if (!userState[chatId] || userState[chatId].step === 'none') {
        bot.sendMessage(chatId, "Tushunmadim. Iltimos, quyidagi tugmalardan birini tanlang:", mainKeyboard);
        return;
    }

    const state = userState[chatId];
    const step = state.step;
    let data = state.data;

    // Mahsulot qo'shish bosqichlari
    if (step.startsWith('product_')) {
        const oldStep = step;
        switch (step) {
            case 'product_name':
                data.name = text;
                state.steps.push(oldStep);
                state.step = 'product_price_piece';
                bot.sendMessage(chatId, "2/8. Dona narxi (USD, raqam, mas: 5.50):", backKeyboard);
                break;
            case 'product_price_piece':
                if (!/^\d+(\.\d{1,2})?$/.test(text) || parseFloat(text) <= 0) {
                    bot.sendMessage(chatId, "Musbat son kiriting (masalan: 5 yoki 5.50)!");
                    return;
                }
                data.pricePiece = parseFloat(text);
                state.steps.push(oldStep);
                state.step = 'product_discount';
                bot.sendMessage(chatId, "3/8. Chegirma (0-100, mas: 10):", backKeyboard);
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
                bot.sendMessage(chatId, "4/8. Kategoriyani tanlang:", categoryKeyboard);
                break;
            case 'product_category':
                if (!data.categoryNames.includes(text)) {
                    bot.sendMessage(chatId, "Iltimos, kategoriyani tugmalardan tanlang!");
                    return;
                }
                data.category = text;
                state.steps.push(oldStep);
                state.step = 'product_image';
                bot.sendMessage(chatId, "5/8. Rasm yuboring (photo formatida):", mainBackKeyboard);
                break;
            case 'product_image':
                return; // Rasm handlerda qayta ishlanadi
            case 'product_description':
                data.description = text;
                state.steps.push(oldStep);
                state.step = 'product_box_capacity';
                bot.sendMessage(chatId, "7/8. Har bir karobkada necha dona bor (raqam, mas: 20):", backKeyboard);
                break;
            case 'product_box_capacity':
                if (!/^\d+$/.test(text) || parseInt(text) <= 0) {
                    bot.sendMessage(chatId, "Musbat son kiriting!");
                    return;
                }
                data.boxCapacity = parseInt(text);
                state.steps.push(oldStep);
                state.step = 'product_stock';
                bot.sendMessage(chatId, "8/8. Ombordagi jami stock (dona soni, mas: 100):", backKeyboard);
                break;
            case 'product_stock':
                if (!/^\d+$/.test(text) || parseInt(text) < 0) {
                    bot.sendMessage(chatId, "0 yoki musbat son kiriting!");
                    return;
                }
                data.stock = parseInt(text);
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
                        `✅ Mahsulot muvaffaqiyatli qo'shildi!
` +
                        `Nomi: ${newProduct.name}
` +
                        `Dona narxi: ${newProduct.pricePiece.toFixed(2)} $
` +
                        `Chegirma: ${newProduct.discount}%
` +
                        `Stock: ${newProduct.stock.toLocaleString()} dona`,
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

    // Kategoriya qo'shish bosqichlari
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
                        `✅ Kategoriya muvaffaqiyatli qo'shildi!
` +
                        `Nomi: ${newCategory.name}
` +
                        `Ikonka: ${newCategory.icon}`,
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

    // TUZATILGAN: Kategoriya yangilash bosqichlari
    if (state.step === 'update_category_name') {
        const stateData = state.data;
        const messageId = stateData.messageId;
        try {
            await db.collection('categories').doc(String(stateData.categoryId)).update({ name: text });
            // State'ni saqlab qolish
            state.step = 'category_update_view';
            await showCategoryView(chatId, stateData.categoryId, messageId);
            bot.sendMessage(chatId,
                `✅ Kategoriya nomi yangilandi: ${text}`,
                backKeyboard
            );
        } catch (error) {
            console.error("Kategoriya nomini yangilashda xato:", error);
            bot.sendMessage(chatId, "❌ Nom yangilashda xato yuz berdi!", mainKeyboard);
            resetUserState(chatId);
        }
        return;
    }
    if (state.step === 'update_category_icon') {
        const stateData = state.data;
        const messageId = stateData.messageId;
        try {
            await db.collection('categories').doc(String(stateData.categoryId)).update({ icon: text });
            // State'ni saqlab qolish
            state.step = 'category_update_view';
            await showCategoryView(chatId, stateData.categoryId, messageId);
            bot.sendMessage(chatId,
                `✅ Kategoriya ikonka yangilandi: ${text}`,
                backKeyboard
            );
        } catch (error) {
            console.error("Kategoriya ikonka yangilashda xato:", error);
            bot.sendMessage(chatId, "❌ Ikonka yangilashda xato yuz berdi!", mainKeyboard);
            resetUserState(chatId);
        }
        return;
    }

    // TUZATILGAN: Mahsulot yangilash bosqichlari
    if (state.step === 'update_value') {
        const stateData = state.data;
        const messageId = stateData.messageId;
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
                fieldNameUz = 'Dona narxi';
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
            await db.collection('products').doc(String(stateData.productId)).update({ [fieldType]: value });
            // State'ni saqlab qolish
            state.step = 'product_update_view';
            await showProductView(chatId, stateData.productId, messageId);
            bot.sendMessage(chatId,
                `✅ ${fieldNameUz} yangilandi: ${value}`,
                backKeyboard
            );
        } catch (error) {
            console.error("Yangilashda xato:", error);
            bot.sendMessage(chatId, "❌ Yangilashda xato yuz berdi!", mainKeyboard);
            resetUserState(chatId);
        }
        return;
    }

    if (state.step === 'update_product_description') {
        const stateData = state.data;
        const messageId = stateData.messageId;
        try {
            await db.collection('products').doc(String(stateData.productId)).update({ description: text });
            // State'ni saqlab qolish
            state.step = 'product_update_view';
            await showProductView(chatId, stateData.productId, messageId);
            bot.sendMessage(chatId,
                `✅ Mahsulot tavsifi yangilandi: ${text.substring(0, 50)}...`,
                backKeyboard
            );
        } catch (error) {
            console.error("Tavsif yangilashda xato:", error);
            bot.sendMessage(chatId, "❌ Tavsif yangilashda xato yuz berdi!", mainKeyboard);
            resetUserState(chatId);
        }
        return;
    }

    if (state.step === 'update_product_name') {
        const stateData = state.data;
        const messageId = stateData.messageId;
        try {
            await db.collection('products').doc(String(stateData.productId)).update({ name: text });
            // State'ni saqlab qolish
            state.step = 'product_update_view';
            await showProductView(chatId, stateData.productId, messageId);
            bot.sendMessage(chatId,
                `✅ Mahsulot nomi yangilandi: ${text}`,
                backKeyboard
            );
        } catch (error) {
            console.error("Nomi yangilashda xato:", error);
            bot.sendMessage(chatId, "❌ Nomi yangilashda xato yuz berdi!", mainKeyboard);
            resetUserState(chatId);
        }
        return;
    }

    bot.sendMessage(chatId, "Tushunmadim. Orqaga bosib oldingizga qayting yoki ❌ Bekor qilish ni bosing.", mainKeyboard);
});

// 7. Photo handler
bot.on('photo', async (msg) => {
    const chatId = msg.chat.id;
    const fileId = msg.photo[msg.photo.length - 1].file_id;

    if (!admins.includes(chatId)) return;
    if (!db) {
        bot.sendMessage(chatId, "❌ Uzr, Database ulanishi yo'q.");
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
                await bot.editMessageText(`✅ Rasm yuklandi!
6/8. Tavsif (qisqa ma'lumot):`, {
                    chat_id: chatId,
                    message_id: waitMessage.message_id
                });
                bot.sendMessage(chatId, "Tavsifni kiriting:", backKeyboard);
            } else if (state.step === 'update_product_image') {
                const stateData = state.data;
                const messageId = stateData.messageId;
                try {
                    await db.collection('products').doc(String(stateData.productId)).update({ image: imageUrl });
                    // State'ni saqlab qolish
                    state.step = 'product_update_view';
                    await showProductView(chatId, stateData.productId, messageId);
                    bot.editMessageText(`✅ Mahsulot rasmi yangilandi!`, {
                        chat_id: chatId,
                        message_id: waitMessage.message_id
                    });
                    bot.sendMessage(chatId, "Orqaga bosing yoki boshqa amalni tanlang.", backKeyboard);
                } catch (error) {
                    console.error("Rasm yangilashda xato:", error);
                    bot.editMessageText("❌ Rasm yangilashda xato yuz berdi!", {
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

// 8. Callback query handler - TUZATILGAN
bot.on('callback_query', async (callbackQuery) => {
    const chatId = callbackQuery.message.chat.id;
    const messageId = callbackQuery.message.message_id;
    const data = callbackQuery.data;

    console.log(`Callback received: ${data}`);

    if (!data || !admins.includes(chatId)) {
        bot.answerCallbackQuery(callbackQuery.id, { text: "Ruxsat yo'q!" });
        return;
    }
    if (!db) {
        bot.answerCallbackQuery(callbackQuery.id, { text: "Database ulanishi yo'q." });
        return;
    }

    // Inline orqaga
    if (data === 'back_to_prev') {
        await handleInlineBack(chatId, messageId);
        bot.answerCallbackQuery(callbackQuery.id, { text: "Orqaga qaytildi!" });
        return;
    }

    // TUZATILGAN: Kategoriya yangilash uchun tanlash
    if (data.startsWith('cat_select_')) {
        const categoryIdStr = data.replace('cat_select_', '');
        const categoryIdNum = parseInt(categoryIdStr);
        if (isNaN(categoryIdNum)) {
            bot.answerCallbackQuery(callbackQuery.id, { text: "Noto'g'ri kategoriya ID!" });
            return;
        }
        try {
            const doc = await db.collection('categories').doc(String(categoryIdNum)).get();
            if (!doc.exists) {
                bot.answerCallbackQuery(callbackQuery.id, { text: "Kategoriya topilmadi!" });
                return;
            }
            const state = userState[chatId] || { step: 'none', data: {}, steps: [] };
            state.steps.push(state.step);
            state.step = 'category_update_view';
            state.data.categoryId = categoryIdNum;
            state.data.messageId = messageId;
            userState[chatId] = state;
            await showCategoryView(chatId, categoryIdNum, messageId);
            bot.answerCallbackQuery(callbackQuery.id, { text: "Kategoriya tanlandi!" });
        } catch (error) {
            console.error("Kategoriyani tanlashda xato:", error);
            bot.answerCallbackQuery(callbackQuery.id, { text: "Xato yuz berdi!" });
        }
        return;
    }

    // TUZATILGAN: Kategoriya nomini yangilash
    if (data.startsWith('cat_update_name_')) {
        const categoryIdStr = data.replace('cat_update_name_', '');
        const categoryIdNum = parseInt(categoryIdStr);
        const state = userState[chatId] || { step: 'none', data: {}, steps: [] };
        // Oldingi state'dan steps'ni saqlab qolish
        const oldSteps = state.steps || [];
        userState[chatId] = {
            step: 'update_category_name',
            data: { categoryId: categoryIdNum, messageId: messageId },
            steps: oldSteps
        };
        bot.sendMessage(chatId, 'Yangi kategoriya nomini kiriting:', backKeyboard);
        bot.answerCallbackQuery(callbackQuery.id, { text: "Nom o'zgartirish tanlandi!" });
        return;
    }

    // TUZATILGAN: Kategoriya ikonkasini yangilash
    if (data.startsWith('cat_update_icon_')) {
        const categoryIdStr = data.replace('cat_update_icon_', '');
        const categoryIdNum = parseInt(categoryIdStr);
        const state = userState[chatId] || { step: 'none', data: {}, steps: [] };
        // Oldingi state'dan steps'ni saqlab qolish
        const oldSteps = state.steps || [];
        userState[chatId] = {
            step: 'update_category_icon',
            data: { categoryId: categoryIdNum, messageId: messageId },
            steps: oldSteps
        };
        bot.sendMessage(chatId, 'Yangi kategoriya ikonka (emoji) ni kiriting:', backKeyboard);
        bot.answerCallbackQuery(callbackQuery.id, { text: "Ikonka o'zgartirish tanlandi!" });
        return;
    }

    // Kategoriyani o'chirish
    if (data.startsWith('delete_category_')) {
        const categoryIdStr = data.replace('delete_category_', '');
        const categoryIdNum = parseInt(categoryIdStr);
        try {
            const doc = await db.collection('categories').doc(String(categoryIdNum)).get();
            if (!doc.exists) {
                bot.answerCallbackQuery(callbackQuery.id, { text: "Kategoriya topilmadi!" });
                return;
            }
            const categoryData = doc.data();
            const productsCount = await getProductsInCategory(categoryData.name);
            if (productsCount === 0) {
                await db.collection('categories').doc(String(categoryIdNum)).delete();
                bot.editMessageText(`✅ Kategoriya "${categoryData.name}" o'chirildi.`, {
                    chat_id: chatId, message_id: messageId, parse_mode: 'Markdown'
                });
                bot.answerCallbackQuery(callbackQuery.id, { text: "Kategoriya o'chirildi!" });
            } else {
                const confirmKeyboard = {
                    reply_markup: {
                        inline_keyboard: [
                            [{ text: `Ha, o'chir (${productsCount} ta mahsulot ham o'chadi)`, callback_data: `confirm_delete_category_${categoryIdNum}` }],
                            [{ text: "Yo'q, bekor qilish", callback_data: 'back_to_prev' }]
                        ],
                    },
                };
                bot.editMessageText(
                    `⚠️ "${categoryData.name}" kategoriyasida ${productsCount} ta mahsulot bor.
` +
                    `Rostan ham o'chirmoqchimisiz?`,
                    {
                        chat_id: chatId, message_id: messageId,
                        reply_markup: confirmKeyboard.reply_markup, parse_mode: 'Markdown'
                    }
                );
                bot.answerCallbackQuery(callbackQuery.id, { text: `Tasdiqlash kutilmoqda...` });
            }
        } catch (error) {
            console.error("Kategoriya o'chirishda xato:", error);
            bot.answerCallbackQuery(callbackQuery.id, { text: "Xato yuz berdi!" });
        }
        return;
    }

    // Mahsulot yangilash uchun kategoriya tanlash
    if (data.startsWith('select_category_')) {
        const categoryIdStr = data.replace('select_category_', '');
        const categoryIdNum = parseInt(categoryIdStr);
        try {
            const doc = await db.collection('categories').doc(String(categoryIdNum)).get();
            if (!doc.exists) {
                bot.answerCallbackQuery(callbackQuery.id, { text: "Kategoriya topilmadi!" });
                return;
            }
            const categoryData = doc.data();
            const state = userState[chatId] || { step: 'none', data: {}, steps: [] };
            state.steps.push(state.step);
            state.step = 'product_update_product_select';
            state.data.selectedCategory = categoryData.name;
            state.data.messageId = messageId; // Mahsulotlar ro'yxatini o'zgartirish uchun messageId saqlanadi
            userState[chatId] = state;
            await showProductsInCategory(chatId, categoryData.name, messageId);
            bot.answerCallbackQuery(callbackQuery.id, { text: "Kategoriya tanlandi!" });
        } catch (error) {
            console.error("Kategoriya mahsulotlarini olishda xato:", error);
            bot.answerCallbackQuery(callbackQuery.id, { text: "Xato yuz berdi!" });
        }
        return;
    }

    // Mahsulot tanlash
    if (data.startsWith('update_product_')) {
        const productIdStr = data.replace('update_product_', '');
        const productIdNum = parseInt(productIdStr);
        try {
            const doc = await db.collection('products').doc(String(productIdNum)).get();
            if (!doc.exists) {
                bot.answerCallbackQuery(callbackQuery.id, { text: "Mahsulot topilmadi!" });
                return;
            }
            const state = userState[chatId] || { step: 'none', data: {}, steps: [] };
            state.steps.push(state.step);
            state.step = 'product_update_view';
            state.data.productId = productIdNum;
            state.data.messageId = messageId;
            userState[chatId] = state;
            await showProductView(chatId, productIdNum, messageId);
            bot.answerCallbackQuery(callbackQuery.id, { text: "Mahsulot tanlandi!" });
        } catch (error) {
            console.error("Mahsulotni tanlashda xato:", error);
            bot.answerCallbackQuery(callbackQuery.id, { text: "Xato yuz berdi!" });
        }
        return;
    }

    // TUZATILGAN: Mahsulot maydonlarini yangilash
    if (data.startsWith('update_field_')) {
        const parts = data.split('_');
        const fieldType = parts[2];
        const productIdStr = parts[3];
        const productIdNum = parseInt(productIdStr);
        const fieldMap = {
            'name': 'Mahsulot nomi',
            'pricePiece': 'Dona narxi (USD)',
            'discount': 'Chegirma (%)',
            'stock': 'Stock (dona)',
            'boxCapacity': 'Karobka sig\'imi',
            'description': 'Tavsif',
            'image': 'Rasm'
        };
        const fieldName = fieldMap[fieldType];
        const state = userState[chatId] || { step: 'none', data: {}, steps: [] };
        const oldSteps = state.steps || [];
        if (fieldType === 'name') {
            userState[chatId] = {
                step: 'update_product_name',
                data: { productId: productIdNum, messageId: messageId },
                steps: oldSteps
            };
            bot.sendMessage(chatId, `Yangi mahsulot nomini kiriting:`, backKeyboard);
        } else if (fieldType === 'description') {
            userState[chatId] = {
                step: 'update_product_description',
                data: { productId: productIdNum, messageId: messageId },
                steps: oldSteps
            };
            bot.sendMessage(chatId, `Yangi tavsifni kiriting:`, backKeyboard);
        } else if (fieldType === 'image') {
            userState[chatId] = {
                step: 'update_product_image',
                data: { productId: productIdNum, messageId: messageId },
                steps: oldSteps
            };
            bot.sendMessage(chatId, 'Yangi rasm yuboring (photo formatida):', mainBackKeyboard);
        } else {
            userState[chatId] = {
                step: 'update_value',
                data: { productId: productIdNum, field: fieldType, messageId: messageId },
                steps: oldSteps
            };
            bot.sendMessage(chatId, `${fieldName} uchun yangi qiymatni yuboring:`, backKeyboard);
        }
        bot.answerCallbackQuery(callbackQuery.id, { text: `${fieldName} tanlandi!` });
        return;
    }

    // Mahsulotni o'chirish
    if (data.startsWith('delete_product_')) {
        const productIdStr = data.replace('delete_product_', '');
        const productIdNum = parseInt(productIdStr);
        try {
            const doc = await db.collection('products').doc(String(productIdNum)).get();
            if (!doc.exists) {
                bot.answerCallbackQuery(callbackQuery.id, { text: "Mahsulot topilmadi!" });
                return;
            }
            const productData = doc.data();
            await db.collection('products').doc(String(productIdNum)).delete();
            bot.editMessageText(`✅ Mahsulot "${productData.name}" o'chirildi.`, {
                chat_id: chatId, message_id: messageId, parse_mode: 'Markdown'
            });
            bot.answerCallbackQuery(callbackQuery.id, { text: "Mahsulot o'chirildi!" });
        } catch (error) {
            console.error("Mahsulot o'chirishda xato:", error);
            bot.answerCallbackQuery(callbackQuery.id, { text: "Xato yuz berdi!" });
        }
        return;
    }
});

console.log("✅ Bot ishga tushdi va polling boshlandi...");
