import type { I18nStrings } from '../types.js';

export const ar: I18nStrings = {
  locale: 'ar',
  dir: 'rtl',
  search: {
    placeholder: 'البحث في الأحداث والوسوم والأوصاف...',
    noResults: 'لا توجد أحداث تطابق معاييرك',
    resultsCount: 'تم العثور على {count} حدث',
  },
  controls: {
    zoomIn: 'تكبير',
    zoomOut: 'تصغير',
    filterByTag: 'تصفية حسب الوسم',
    clearFilters: 'إعادة تعيين',
    allTags: 'جميع الوسوم',
  },
  event: {
    readMore: 'المزيد',
    collapse: 'طي',
    media: 'الوسائط المرفقة',
    location: 'الموقع',
  },
  timeline: {
    loading: 'جاري تحميل الجدول الزمني...',
    empty: 'لا توجد أحداث لعرضها في هذا الجدول الزمني',
    error: 'فشل تحميل بيانات الجدول الزمني',
  },
  aria: {
    timelineLabel: 'جدول زمني تفاعلي',
    eventList: 'تسلسل الأحداث الزمنية',
    eventItem: 'الحدث: {title}',
    navigation: 'عناصر التحكم في الجدول الزمني',
    skipToContent: 'الانتقال مباشرة إلى الأحداث',
    expandEvent: 'توسيع تفاصيل {title}',
    collapseEvent: 'طي تفاصيل {title}',
  },
  dates: {
    bce: 'ق.م',
    ce: 'م',
    circa: 'حوالي',
    uncertain: '؟',
    present: 'الحاضر',
    to: 'إلى',
  },
};
