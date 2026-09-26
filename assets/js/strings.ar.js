// All Arabic UI strings, grouped by page/area. No UI text should be hardcoded elsewhere.
// Placeholders use {name} and are filled by t() in utils.js.
// Storefront copy addresses the customer in the feminine form; admin copy stays neutral.

const strings = {
  meta: {
    brand: 'Shami Cosmetics',
    tagline: 'عناية فاخرة تبدأ من التفاصيل',
  },

  common: {
    currency: 'د.أ',
    loading: 'جارٍ التحميل…',
    retry: 'إعادة المحاولة',
    close: 'إغلاق',
    cancel: 'إلغاء',
    confirm: 'تأكيد',
    save: 'حفظ',
    edit: 'تعديل',
    delete: 'حذف',
    back: 'رجوع',
    next: 'التالي',
    search: 'بحث',
    yes: 'نعم',
    no: 'لا',
    optional: 'اختياري',
    copy: 'نسخ',
    copied: 'تم النسخ',
    am: 'ص',
    pm: 'م',
    months: [
      'كانون الثاني', 'شباط', 'آذار', 'نيسان', 'أيار', 'حزيران',
      'تموز', 'آب', 'أيلول', 'تشرين الأول', 'تشرين الثاني', 'كانون الأول',
    ],
  },

  header: {
    skipToContent: 'تخطي إلى المحتوى',
    mainNav: 'القائمة الرئيسية',
    openMenu: 'فتح القائمة',
    closeMenu: 'إغلاق القائمة',
    home: 'الرئيسية',
    quiz: 'اختبار البشرة',
    track: 'تتبع الطلب',
    account: 'حسابي',
    login: 'تسجيل الدخول',
    cart: 'السلة',
    cartWithCount: 'السلة — عدد القطع: {count}',
    announcements: 'إعلانات المتجر',
  },

  footer: {
    about: 'براند أردني متخصص في الصابون التركي الطبي الأصلي وعطور TWINS الفاخرة.',
    shopTitle: 'تسوقي',
    allProducts: 'كل المنتجات',
    helpTitle: 'المساعدة',
    trackOrder: 'تتبعي طلبك',
    returns: 'سياسة الاستبدال والإرجاع',
    myAccount: 'حسابي',
    contactTitle: 'تواصلي معنا',
    whatsapp: 'واتساب',
    social: {
      instagram: 'إنستغرام',
      facebook: 'فيسبوك',
      tiktok: 'تيك توك',
      snapchat: 'سناب شات',
    },
    rights: '© {year} Shami Cosmetics — جميع الحقوق محفوظة',
  },

  whatsapp: {
    floatLabel: 'تواصلي معنا عبر واتساب',
    greeting: 'مرحبًا Shami Cosmetics، عندي استفسار',
  },

  states: {
    loading: 'جارٍ التحميل…',
    emptyTitle: 'لا يوجد شيء هنا بعد',
    errorTitle: 'حدث خطأ',
  },

  confirm: {
    title: 'تأكيد الإجراء',
  },

  validation: {
    required: 'هذا الحقل مطلوب',
    phoneInvalid: 'رقم الهاتف غير صحيح. أدخلي رقمًا أردنيًا يبدأ بـ 077 أو 078 أو 079',
    emailInvalid: 'البريد الإلكتروني غير صحيح',
    minLength: 'يجب ألا يقل عن {min} أحرف',
    passwordMismatch: 'كلمتا المرور غير متطابقتين',
    numberInvalid: 'أدخلي رقمًا صحيحًا',
    qtyMax: 'المتوفر {max} فقط',
  },

  // Error CODES returned by RPC functions / mapped from Supabase errors → Arabic message.
  // SQL functions must raise exactly these codes (e.g. RAISE EXCEPTION 'OUT_OF_STOCK').
  errors: {
    UNKNOWN: 'حدث خطأ غير متوقع. حاولي مرة أخرى.',
    NETWORK: 'تعذّر الاتصال. تحققي من الإنترنت وحاولي مرة أخرى.',
    CONFIG_MISSING: 'المتجر غير مهيأ بعد. يرجى المحاولة لاحقًا.',
    SESSION_EXPIRED: 'انتهت الجلسة. سجّلي الدخول مرة أخرى.',
    NOT_AUTHORIZED: 'ليس لديك صلاحية للقيام بهذا الإجراء.',
    NOT_FOUND: 'العنصر المطلوب غير موجود.',
    DUPLICATE: 'هذه القيمة مستخدمة مسبقًا.',
    RATE_LIMITED: 'محاولات كثيرة خلال وقت قصير. حاولي بعد قليل.',
    STORE_CLOSED: 'المتجر مغلق حاليًا ولا يستقبل طلبات جديدة.',

    // Cart & stock
    EMPTY_CART: 'السلة فارغة.',
    VARIANT_NOT_FOUND: 'أحد المنتجات لم يعد متوفرًا.',
    VARIANT_INACTIVE: 'أحد المنتجات لم يعد متوفرًا.',
    OUT_OF_STOCK: 'نفذت الكمية من أحد المنتجات في سلتك.',
    INSUFFICIENT_STOCK: 'الكمية المطلوبة من أحد المنتجات أكبر من المتوفر.',

    // Checkout
    INVALID_PHONE: 'رقم الهاتف غير صحيح.',
    INVALID_GOVERNORATE: 'المحافظة المختارة غير متاحة للتوصيل.',
    INVALID_PAYMENT_METHOD: 'طريقة الدفع غير متاحة.',

    // Coupons
    COUPON_NOT_FOUND: 'كود الخصم غير صحيح.',
    COUPON_INACTIVE: 'كود الخصم غير فعّال.',
    COUPON_NOT_STARTED: 'كود الخصم لم يبدأ بعد.',
    COUPON_EXPIRED: 'انتهت صلاحية كود الخصم.',
    COUPON_MIN_ORDER: 'قيمة الطلب أقل من الحد الأدنى لاستخدام هذا الكود.',
    COUPON_USAGE_LIMIT: 'تم استخدام هذا الكود للحد الأقصى.',
    COUPON_PHONE_LIMIT: 'استخدمتِ هذا الكود من قبل.',
    COUPON_NOT_COMBINABLE: 'لا يمكن استخدام هذا الكود مع العروض الحالية.',

    // Orders & payments
    ORDER_NOT_FOUND: 'لم نجد طلبًا بهذه البيانات. تأكدي من رقم الطلب ورقم الهاتف.',
    CANNOT_CANCEL: 'لا يمكن إلغاء الطلب في حالته الحالية.',
    INVALID_TRANSITION: 'لا يمكن نقل الطلب إلى هذه الحالة.',
    PAYMENT_NOT_VERIFIED: 'لا يمكن تسليم الطلب لشركة التوصيل قبل تأكيد الدفع.',
    RECEIPT_ALREADY_UPLOADED: 'تم رفع إيصال التحويل مسبقًا.',
    FILE_TOO_LARGE: 'حجم الملف كبير جدًا.',
    FILE_TYPE_INVALID: 'نوع الملف غير مدعوم. استخدمي صورة.',

    // Reviews
    REVIEW_EXISTS: 'أضفتِ تقييمًا لهذا الطلب من قبل.',
    ORDER_NOT_DELIVERED: 'يمكنك التقييم بعد استلام الطلب.',

    // Staff
    USER_NOT_FOUND: 'لا يوجد حساب بهذا البريد الإلكتروني.',

    // Auth (mapped from Supabase auth error codes as AUTH_<CODE>)
    AUTH_INVALID_CREDENTIALS: 'البريد الإلكتروني أو كلمة المرور غير صحيحة.',
    AUTH_EMAIL_NOT_CONFIRMED: 'يرجى تأكيد بريدك الإلكتروني أولًا من الرسالة التي وصلتك.',
    AUTH_USER_ALREADY_EXISTS: 'يوجد حساب مسجّل بهذا البريد الإلكتروني.',
    AUTH_EMAIL_EXISTS: 'يوجد حساب مسجّل بهذا البريد الإلكتروني.',
    AUTH_WEAK_PASSWORD: 'كلمة المرور ضعيفة. استخدمي 8 أحرف على الأقل.',
    AUTH_SAME_PASSWORD: 'كلمة المرور الجديدة يجب أن تختلف عن القديمة.',
    AUTH_OVER_EMAIL_SEND_RATE_LIMIT: 'أرسلنا رسائل كثيرة مؤخرًا. حاولي بعد قليل.',
    AUTH_OVER_REQUEST_RATE_LIMIT: 'محاولات كثيرة خلال وقت قصير. حاولي بعد قليل.',
  },
};

export default strings;
