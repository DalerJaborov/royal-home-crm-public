// Расстояние берётся из общего пакета, а не пишется здесь второй раз: та же
// формула стояла на сервере, и копия разошлась бы с первой правкой одной из
// сторон — молча, потому что каждая сторона согласна сама с собой. А на этом
// расстоянии стоит правило подбора «радиус 1 км»: разные метры у сервера и у
// карты означают, что агент видит не тот набор объектов, по которому сервер
// принял решение. Разбор — в шапке packages/shared/src/geo.ts (правка #752).
export { distanceMeters } from "@royal-home/shared";

/** Кольцо точек окружности радиусом `radiusM` вокруг центра — для рисования
 *  зоны «рядом со мной» на карте без сторонней геометрической библиотеки
 *  (turf не подключаем, задача разовая и маленькая). */
export function circlePolygon(lat: number, lng: number, radiusM: number, steps = 48): [number, number][] {
  const points: [number, number][] = [];
  const latRad = (lat * Math.PI) / 180;
  const degLat = radiusM / 111_320;
  const degLng = radiusM / (111_320 * Math.cos(latRad));
  for (let i = 0; i <= steps; i++) {
    const angle = (i / steps) * 2 * Math.PI;
    points.push([lng + degLng * Math.cos(angle), lat + degLat * Math.sin(angle)]);
  }
  return points;
}
