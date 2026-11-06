// Run this on a new server before moving the bot there: the DTEK site may treat a server's IP
// differently from a home connection. Exits with an error if the site does not let it through.
//
//   node tools/check-site.js

import { createDtekClient } from '../src/dtek.js';

const client = createDtekClient();

try {
  const page = await client.loadPage();
  const cities = Object.keys(page.streets);
  console.log(`Страница: есть, населённых пунктов ${cities.length}, обновлено ${page.fact.update || 'нет данных'}`);

  await client.checkUpdate(page.fact.update);
  console.log('Проверка обновлений: работает');

  const city = cities.find((name) => page.streets[name].length > 0 && page.streets[name][0] !== '');
  const houses = await client.lookupHouses(city, page.streets[city][0]);
  console.log(`Поиск по адресу: работает, домов на примере улицы ${Object.keys(houses).length}`);

  console.log('ГОТОВО: сайт пропускает бота с этого адреса');
} catch (error) {
  console.error(`НЕ ПОЛУЧИЛОСЬ: ${error.message}`);
  process.exit(1);
}
