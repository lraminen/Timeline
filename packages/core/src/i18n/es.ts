import type { I18nStrings } from "../types.js";

export const es: I18nStrings = {
  locale: "es",
  dir: "ltr",
  search: {
    placeholder: "Buscar eventos, etiquetas y descripciones...",
    noResults: "No hay eventos que coincidan con los criterios",
    resultsCount: "{count} eventos encontrados",
  },
  controls: {
    zoomIn: "Acercar",
    zoomOut: "Alejar",
    filterByTag: "Filtrar por etiqueta",
    clearFilters: "Limpiar filtros",
    allTags: "Todas las etiquetas",
  },
  event: {
    readMore: "Leer más",
    collapse: "Colapsar",
    media: "Archivos adjuntos",
    location: "Ubicación",
  },
  timeline: {
    loading: "Cargando cronología...",
    empty: "No hay eventos para mostrar en esta cronología",
    error: "Error al cargar los datos de la cronología",
  },
  aria: {
    timelineLabel: "Cronología interactiva",
    eventList: "Secuencia de eventos cronológicos",
    eventItem: "Evento: {title}",
    navigation: "Controles de navegación de la cronología",
    skipToContent: "Saltar a los eventos de la cronología",
    expandEvent: "Expandir detalles para {title}",
    collapseEvent: "Colapsar detalles para {title}",
  },
  dates: {
    bce: "a.C.",
    ce: "d.C.",
    circa: "c.",
    uncertain: "?",
    present: "Presente",
    to: "a",
  },
};
