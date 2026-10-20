import { PrismaClient } from "../src/generated/prisma/client.js";
import { makePrismaAdapter } from "../src/lib/prismaAdapter.js";

const prisma = new PrismaClient({ adapter: makePrismaAdapter(process.env.DATABASE_URL ?? "") });

async function main() {
  console.log("Сидирование базы данных...");

  const districts = await Promise.all(
    ["Сино", "Исмоили Сомони", "Фирдавси", "Шохмансур"].map((name) =>
      prisma.district.upsert({
        where: { name },
        update: {},
        create: { name },
      })
    )
  );
  const [sino, somoni, firdavsi, shohmansur] = districts;

  /**
   * Сидовые аккаунты — не новые сотрудники первого дня, а уже освоившиеся в CRM.
   * Онбординг-тур (OnboardingTour.tsx) блокирует главную полноэкранным оверлеем,
   * пока не пройден или не закрыт, — без этого флага e2e, впервые логинящийся
   * после чистой базы, тут же упирается в него: тур перехватывает клики раньше,
   * чем тест успевает дойти до проверяемого экрана.
   */
  const onboarded = { onboardingCompletedAt: new Date(0).toISOString() };

  await prisma.agent.upsert({
    where: { phone: "+992900000000" },
    update: { preferences: onboarded },
    create: {
      fullName: "Фарход Назаров",
      phone: "+992900000000",
      email: "farhod@royalhome.tj",
      role: "DIRECTOR",
      avatarUrl: "https://i.pravatar.cc/300?img=59",
      preferences: onboarded,
    },
  });

  const admin = await prisma.agent.upsert({
    where: { phone: "+992900000001" },
    update: { avatarUrl: "https://i.pravatar.cc/300?img=12", preferences: onboarded },
    create: {
      fullName: "Азиз Рахимов",
      phone: "+992900000001",
      email: "aziz@royalhome.tj",
      role: "ADMIN",
      avatarUrl: "https://i.pravatar.cc/300?img=12",
      preferences: onboarded,
    },
  });

  const madina = await prisma.agent.upsert({
    where: { phone: "+992900000002" },
    update: { avatarUrl: "https://i.pravatar.cc/300?img=47", preferences: onboarded },
    create: {
      fullName: "Мадина Каримова",
      phone: "+992900000002",
      email: "madina@royalhome.tj",
      role: "AGENT",
      avatarUrl: "https://i.pravatar.cc/300?img=47",
      preferences: onboarded,
    },
  });

  const daler = await prisma.agent.upsert({
    where: { phone: "+992900000003" },
    update: { avatarUrl: "https://i.pravatar.cc/300?img=33", preferences: onboarded },
    create: {
      fullName: "Далер Сафаров",
      phone: "+992900000003",
      email: "daler@royalhome.tj",
      role: "AGENT",
      avatarUrl: "https://i.pravatar.cc/300?img=33",
      preferences: onboarded,
    },
  });

  const manager = await prisma.agent.upsert({
    where: { phone: "+992900000004" },
    update: { avatarUrl: "https://i.pravatar.cc/300?img=45", preferences: onboarded },
    create: {
      fullName: "Нилуфар Юсупова",
      phone: "+992900000004",
      email: "nilufar@royalhome.tj",
      role: "MANAGER",
      avatarUrl: "https://i.pravatar.cc/300?img=45",
      preferences: onboarded,
    },
  });

  /**
   * МАРКЕТИНГ, МОНТАЖЁР И СБ — БЕЗ НИХ ИХ РАБОТУ НИКТО НЕ ВИДИТ.
   *
   * До 06.08.2026 сид знал только директора, админа, двух агентов и руководителя.
   * Следствие оказалось дороже, чем выглядит: под этими тремя ролями нельзя было
   * войти локально → e2e под них не писались → ни один прогон ни разу не прошёл
   * рабочий день маркетолога или монтажёра. Все дефекты, которые владелец нашёл
   * руками за один вечер (чужие вкладки в меню, кнопка «Одобрить» у агента,
   * отсутствие уведомлений о новой работе), лежали ровно в этой слепой зоне.
   * Роль, которой нет в сиде, — это роль, которую никто не тестирует.
   */
  const marketing = await prisma.agent.upsert({
    where: { phone: "+992900000005" },
    update: { avatarUrl: "https://i.pravatar.cc/300?img=26", preferences: onboarded },
    create: {
      fullName: "Зарина Холова",
      phone: "+992900000005",
      email: "zarina@royalhome.tj",
      role: "MARKETING",
      avatarUrl: "https://i.pravatar.cc/300?img=26",
      preferences: onboarded,
    },
  });

  const editor = await prisma.agent.upsert({
    where: { phone: "+992900000006" },
    update: { avatarUrl: "https://i.pravatar.cc/300?img=68", preferences: onboarded },
    create: {
      fullName: "Сомон Рахмонов",
      phone: "+992900000006",
      email: "somon@royalhome.tj",
      role: "EDITOR",
      avatarUrl: "https://i.pravatar.cc/300?img=68",
      preferences: onboarded,
    },
  });

  await prisma.agent.upsert({
    where: { phone: "+992900000007" },
    update: { avatarUrl: "https://i.pravatar.cc/300?img=51", preferences: onboarded },
    create: {
      fullName: "Рустам Шарипов",
      phone: "+992900000007",
      email: "rustam@royalhome.tj",
      role: "SECURITY",
      avatarUrl: "https://i.pravatar.cc/300?img=51",
      preferences: onboarded,
    },
  });

  /**
   * ОПЕРАТОР — шаблонный аккаунт под роль из мобильного хендоффа 17.08.2026
   * (звонки и приём лидов, номера клиентов всегда маскируются). В системе нет
   * отдельной Role "OPERATOR" — заводить её значило бы менять enum в схеме
   * (Prisma) и гнать миграцию на живой базе ради роли, права которой уже
   * буквально совпадают с существующей ROLE_PRESETS.MANAGER (нет
   * clients.viewPhone/calls.transcripts/finance.*, есть приём и распределение
   * лидов) — решение той же ночи, не отдельное.
   *
   * ⚠️ ШАБЛОН, НЕ ЖИВОЙ СОТРУДНИК. Аккаунт заведён, чтобы роль можно было
   * увидеть и потестировать (вход, мобильная Главная MobileHomeOperator.tsx).
   * Отдельного рабочего места оператора входящих в CRM больше нет: 18.08.2026
   * владелец отказался от роли и от браузерной трубки целиком, разговор
   * разбирает сама CRM по расшифровке (lib/telephony/autoLeadFromCall.ts).
   */
  await prisma.agent.upsert({
    where: { phone: "+992900000008" },
    update: { avatarUrl: "https://i.pravatar.cc/300?img=33", preferences: onboarded },
    create: {
      fullName: "Оператор (шаблон)",
      phone: "+992900000008",
      email: "operator@royalhome.tj",
      role: "MANAGER",
      avatarUrl: "https://i.pravatar.cc/300?img=33",
      preferences: onboarded,
    },
  });

  /**
   * АКЦИОНЕР и РОП (10.10.2026): демо-учётки новых ролей, чтобы их можно было
   * открыть локально (роль, которой нет в сиде, никем не тестируется). Телефоны
   * ...06–...08 заняты монтажёром, СБ и оператором, поэтому ...09 и ...10.
   */
  await prisma.agent.upsert({
    where: { phone: "+992900000009" },
    update: { avatarUrl: "https://i.pravatar.cc/300?img=12", preferences: onboarded },
    create: {
      fullName: "Акционер",
      phone: "+992900000009",
      email: "shareholder@royalhome.tj",
      role: "SHAREHOLDER",
      avatarUrl: "https://i.pravatar.cc/300?img=12",
      preferences: onboarded,
    },
  });

  await prisma.agent.upsert({
    where: { phone: "+992900000010" },
    update: { avatarUrl: "https://i.pravatar.cc/300?img=15", preferences: onboarded },
    create: {
      fullName: "РОП",
      phone: "+992900000010",
      email: "rop@royalhome.tj",
      role: "HEAD_OF_SALES",
      avatarUrl: "https://i.pravatar.cc/300?img=15",
      preferences: onboarded,
    },
  });

  const agents = [admin, madina, daler];

  const properties = [
    { title: "3-комн · ул. Айни, 24", type: "APARTMENT", rooms: 3, areaSqm: 82, floor: 4, totalFloors: 9, price: 65000, district: sino, address: "ул. Айни, 24", condition: "GOOD", status: "AVAILABLE", views: 6 },
    { title: "Дом · Шохмансур, тихая улица", type: "HOUSE", rooms: 5, areaSqm: 160, price: 98000, district: shohmansur, address: "ул. Дружбы Народов, 12", condition: "EXCELLENT", status: "AVAILABLE", views: 2 },
    { title: "2-комн · Фирдавси, новостройка", type: "APARTMENT", rooms: 2, areaSqm: 54, floor: 7, totalFloors: 12, price: 42000, district: firdavsi, address: "ул. Фирдавси, 8", condition: "NEW_BUILDING", status: "RESERVED", views: 4 },
    { title: "2-комн · Исмоили Сомони, центр", type: "APARTMENT", rooms: 2, areaSqm: 61, floor: 3, totalFloors: 5, price: 55000, district: somoni, address: "пр. Рудаки, 45", condition: "GOOD", status: "AVAILABLE", views: 1 },
    { title: "1-комн · Сино, у парка", type: "APARTMENT", rooms: 1, areaSqm: 38, floor: 2, totalFloors: 5, price: 28000, district: sino, address: "ул. Бухоро, 15", condition: "GOOD", status: "AVAILABLE", views: 3 },
    { title: "4-комн · Шохмансур, элитный", type: "APARTMENT", rooms: 4, areaSqm: 128, floor: 8, totalFloors: 14, price: 145000, district: shohmansur, address: "ул. Носира Махмудова, 3", condition: "EXCELLENT", status: "AVAILABLE", views: 5 },
    { title: "Коммерческое · Фирдавси, 1-я линия", type: "COMMERCIAL", areaSqm: 95, floor: 1, totalFloors: 5, price: 87000, district: firdavsi, address: "ул. Фирдавси, 32", condition: "GOOD", status: "AVAILABLE", views: 2 },
    { title: "Участок · Сино, под застройку", type: "LAND", areaSqm: 600, price: 36000, district: sino, address: "массив Гулистон", condition: "GOOD", status: "AVAILABLE", views: 0 },
    { title: "2-комн · Сомони, вторичка", type: "APARTMENT", rooms: 2, areaSqm: 58, floor: 5, totalFloors: 9, price: 47000, district: somoni, address: "ул. Мирзо Турсунзаде, 20", condition: "GOOD", status: "SOLD", views: 9, sold: true },
    { title: "Дом · Фирдавси, с гаражом", type: "HOUSE", rooms: 4, areaSqm: 140, price: 110000, district: firdavsi, address: "ул. Гагарина, 56", condition: "GOOD", status: "AVAILABLE", views: 3 },
    { title: "1-комн · Шохмансур, свежий ремонт", type: "APARTMENT", rooms: 1, areaSqm: 41, floor: 6, totalFloors: 10, price: 33000, district: shohmansur, address: "ул. Сомони, 78", condition: "EXCELLENT", status: "AVAILABLE", views: 7 },
    { title: "3-комн · Сино, требует ремонта", type: "APARTMENT", rooms: 3, areaSqm: 75, floor: 1, totalFloors: 5, price: 39000, district: sino, address: "ул. Ленинград, 9", condition: "NEEDS_REPAIR", status: "AVAILABLE", views: 1 },
    { title: "2-комн · Зарафшон", type: "APARTMENT", rooms: 2, areaSqm: 56, floor: 4, totalFloors: 9, price: 38500, district: somoni, address: "мкр. Зарафшон, 14", condition: "GOOD", status: "AVAILABLE", views: 0 },
    { title: "Коммерческое · Сомони, офис", type: "COMMERCIAL", areaSqm: 62, floor: 2, totalFloors: 6, price: 51000, district: somoni, address: "пр. Рудаки, 88", condition: "GOOD", status: "WITHDRAWN", views: 2 },
    { title: "Дом · Сино, новый", type: "HOUSE", rooms: 6, areaSqm: 210, price: 175000, district: sino, address: "ул. Истиклол, 40", condition: "NEW_BUILDING", status: "AVAILABLE", views: 4 },
    // КОНВЕЙЕР ПОДГОТОВКИ — по объекту на каждую стадию. Без них кабинет маркетинга
    // и очередь монтажёра пустые: проверять нечего и показывать на презентации нечего,
    // хотя это одна из самых сильных частей системы (Owner Flow владельца).
    { title: "3-комн · Сомони, на проверке", type: "APARTMENT", rooms: 3, areaSqm: 79, floor: 6, totalFloors: 9, price: 61000, district: somoni, address: "ул. Хусейнзода, 11", condition: "GOOD", status: "PENDING_REVIEW", views: 0 },
    { title: "2-комн · Сино, ждёт фото", type: "APARTMENT", rooms: 2, areaSqm: 52, floor: 3, totalFloors: 5, price: 40000, district: sino, address: "ул. Дехлави, 7", condition: "GOOD", status: "AWAITING_PHOTOS", views: 0 },
    { title: "Дом · Фирдавси, ждёт видео", type: "HOUSE", rooms: 4, areaSqm: 155, price: 105000, district: firdavsi, address: "ул. Борбад, 23", condition: "EXCELLENT", status: "AWAITING_VIDEO", views: 0 },
    { title: "4-комн · Шохмансур, в монтаже", type: "APARTMENT", rooms: 4, areaSqm: 112, floor: 5, totalFloors: 12, price: 132000, district: shohmansur, address: "ул. Турсунзода, 64", condition: "EXCELLENT", status: "EDITING", views: 0 },
  ] as const;

  // LoremFlickr отдаёт настоящие фото с Flickr по тегам (не случайный шум, как Picsum) —
  // для квартиры реально приходит квартира/интерьер, а не пейзаж или текстура камня.
  // lock=<число> — детерминированный выбор, чтобы одна и та же карточка не меняла фото при пересборке.
  const PHOTO_KEYWORDS: Record<string, string> = {
    APARTMENT: "apartment,interior",
    HOUSE: "house,exterior",
    COMMERCIAL: "office,building",
    LAND: "land,field",
  };
  function propertyPhotos(type: string, lockBase: number, count: number) {
    const keywords = PHOTO_KEYWORDS[type] ?? "realestate";
    return Array.from({ length: count }, (_, n) => {
      const lock = lockBase * 10 + n;
      return {
        url: `https://loremflickr.com/900/600/${keywords}?lock=${lock}`,
        thumbUrl: `https://loremflickr.com/400/300/${keywords}?lock=${lock}`,
        order: n,
      };
    });
  }

  const createdProperties = [];
  /** Стадии конвейера, у которых есть срок и ответственный. */
  const PIPELINE_STATUSES = ["PENDING_REVIEW", "AWAITING_PHOTOS", "AWAITING_VIDEO", "EDITING"];

  for (let i = 0; i < properties.length; i++) {
    const p = properties[i];
    const agent = agents[i % agents.length];
    const inPipeline = PIPELINE_STATUSES.includes(p.status);
    // Разный возраст стадии: свежий объект, вчерашний и просроченный — чтобы на
    // экране маркетинга сразу были видны все три цвета индикации, а не один.
    const stageAgeHours = inPipeline ? [3, 26, 80, 50][i % 4] : 0;
    const created = await prisma.property.create({
      data: {
        ...(inPipeline
          ? {
              stageEnteredAt: new Date(Date.now() - stageAgeHours * 60 * 60 * 1000),
              // Объект в конвейере ведёт тот, кто его завёл — от него же считается
              // ответственность за просрочку фото/видео.
              intakeAgentId: agent.id,
            }
          : {}),
        title: p.title,
        type: p.type as any,
        rooms: p.rooms,
        areaSqm: p.areaSqm,
        floor: p.floor,
        totalFloors: p.totalFloors,
        // Цены в исходном массиве заданы в условных тысячах — переводим в сомони (курс ≈ 11 смн/$).
        price: p.price * 11,
        currency: "TJS",
        districtId: p.district.id,
        address: p.address,
        condition: p.condition as any,
        amenities: ["парковка", "лифт"].slice(0, (i % 2) + 1),
        status: p.status as any,
        assignedAgentId: agent.id,
        viewsCount: p.views,
        soldAt: p.sold ? new Date() : undefined,
        soldPrice: p.sold ? p.price * 11 : undefined,
        photos: {
          create: propertyPhotos(p.type, i, 3),
        },
      },
    });
    createdProperties.push(created);
  }

  const clientsData = [
    { fullName: "Фаррух Назаров", phone: "+992907000001", status: "HOT", source: "INSTAGRAM", budgetMin: 55000, budgetMax: 70000, district: sino, rooms: 3, notes: "Ищет тихую улицу, не первый этаж, рядом школа" },
    { fullName: "Мадина Каримова-клиент", phone: "+992907000002", status: "CONTACTED", source: "WEBSITE", budgetMin: 90000, budgetMax: 105000, district: shohmansur, rooms: 5, notes: "Нужен дом с участком, для семьи с детьми" },
    { fullName: "Джамшед Расулов", phone: "+992907000003", status: "NEW", source: "WHATSAPP", budgetMin: 35000, budgetMax: 45000, district: firdavsi, rooms: 2, notes: "2-комн до $45k, Фирдавси или Сино" },
    { fullName: "Нилуфар Шарипова", phone: "+992907000004", status: "COLD", source: "REFERRAL", budgetMin: 45000, budgetMax: 60000, district: somoni, rooms: 2, notes: "В процессе решения по ипотеке" },
    { fullName: "Сорбон Абдуллоев", phone: "+992907000005", status: "NEW", source: "INSTAGRAM", budgetMin: 25000, budgetMax: 30000, district: sino, rooms: 1, notes: "Ищет 1-комн до $30k" },
    { fullName: "Гулнора Исмоилова", phone: "+992907000006", status: "HOT", source: "PHONE_CALL", budgetMin: 130000, budgetMax: 150000, district: shohmansur, rooms: 4, notes: "Элитное жильё, готова к сделке" },
    { fullName: "Комрон Валиев", phone: "+992907000007", status: "UNRESPONSIVE", source: "WEBSITE", budgetMin: 80000, budgetMax: 90000, district: firdavsi, rooms: null, notes: "Не отвечает 2 недели" },
    { fullName: "Зарина Холова", phone: "+992907000008", status: "DEAL_CLOSED", source: "REFERRAL", budgetMin: 45000, budgetMax: 50000, district: somoni, rooms: 2, notes: "Сделка закрыта в июне" },
    { fullName: "Умед Собиров", phone: "+992907000009", status: "CONTACTED", source: "FACEBOOK", budgetMin: 30000, budgetMax: 40000, district: sino, rooms: 3, notes: "Требуется ремонт — не проблема, ищет дёшево" },
    { fullName: "Ситора Назарова", phone: "+992907000010", status: "NEW", source: "WALK_IN", budgetMin: 100000, budgetMax: 120000, district: firdavsi, rooms: 4, notes: "Пришла в офис, смотрит дом с гаражом" },
  ] as const;

  const createdClients = [];
  for (let i = 0; i < clientsData.length; i++) {
    const c = clientsData[i];
    const agent = agents[i % agents.length];
    const client = await prisma.client.create({
      data: {
        fullName: c.fullName,
        phone: c.phone,
        status: c.status as any,
        source: c.source as any,
        budgetMin: c.budgetMin * 11,
        budgetMax: c.budgetMax * 11,
        currency: "TJS",
        desiredDistrictId: c.district.id,
        desiredRooms: c.rooms ?? undefined,
        requirementsNotes: c.notes,
        assignedAgentId: agent.id,
        // Демо-клиенты — уже устоявшиеся отношения агента с клиентом, а не свежие лиды
        // в очереди на распределение: принятыми должны быть сразу, иначе весь сид выглядит
        // так, будто агент ничего не принял (см. acceptedAt в схеме Client).
        acceptedAt: new Date(),
      },
    });

    await prisma.interaction.create({
      data: {
        clientId: client.id,
        agentId: agent.id,
        type: "SYSTEM",
        notes: `Клиент создан, источник: ${c.source}`,
      },
    });

    if (c.status === "HOT" || c.status === "CONTACTED") {
      await prisma.interaction.create({
        data: {
          clientId: client.id,
          agentId: agent.id,
          type: "CALL",
          notes: "Обсудили требования по бюджету и району",
          outcome: "POSITIVE",
          nextAction: "Отправить подборку объектов",
          nextActionDate: new Date(Date.now() + 2 * 24 * 60 * 60 * 1000),
        },
      });
    }

    createdClients.push(client);
  }

  const deals = [
    {
      client: createdClients[0], // Фаррух Назаров
      property: createdProperties[0], // 3-комн · ул. Айни, 24
      agent: admin,
      stage: "NEGOTIATION",
      commissionPercent: 3,
      startedDaysAgo: 6,
    },
    {
      client: createdClients[1], // Мадина Каримова-клиент
      property: createdProperties[1], // Дом · Шохмансур, тихая улица
      agent: madina,
      stage: "AGREEMENT_PENDING",
      commissionPercent: 3,
      startedDaysAgo: 11,
    },
    {
      client: createdClients[5], // Гулнора Исмоилова
      property: createdProperties[5], // 4-комн · Шохмансур, элитный
      agent: daler,
      stage: "CONTRACT_SIGNED",
      commissionPercent: 3.5,
      startedDaysAgo: 18,
    },
    {
      client: createdClients[7], // Зарина Холова
      property: createdProperties[8], // 2-комн · Сомони, вторичка (SOLD)
      agent: admin,
      stage: "COMPLETED",
      commissionPercent: 3,
      startedDaysAgo: 40,
      closedDaysAgo: 12,
    },
    {
      client: createdClients[8], // Умед Собиров
      property: createdProperties[11], // 3-комн · Сино, требует ремонта
      agent: madina,
      stage: "NEGOTIATION",
      commissionPercent: 2.5,
      startedDaysAgo: 3,
    },
    {
      client: createdClients[6], // Комрон Валиев
      property: createdProperties[9], // Дом · Фирдавси, с гаражом
      agent: daler,
      stage: "CANCELLED",
      commissionPercent: 3,
      startedDaysAgo: 25,
    },
  ] as const;

  const DAY = 24 * 60 * 60 * 1000;

  for (const d of deals) {
    const startedAt = new Date(Date.now() - d.startedDaysAgo * DAY);
    const closedAt = "closedDaysAgo" in d ? new Date(Date.now() - d.closedDaysAgo * DAY) : undefined;
    const commissionAmount = (Number(d.property.price) * d.commissionPercent) / 100;
    await prisma.deal.create({
      data: {
        clientId: d.client.id,
        propertyId: d.property.id,
        agentId: d.agent.id,
        stage: d.stage as any,
        commissionPercent: d.commissionPercent,
        commissionAmount: d.stage === "COMPLETED" ? commissionAmount : d.stage === "CANCELLED" ? undefined : commissionAmount,
        startedAt,
        closedAt,
      },
    });

    // Завершённые/отменённые сделки — терминальное состояние клиента: без объясняющих
    // записей в хронологии статус на карточке ("Сделка закрыта") повисает без истории.
    if (d.stage === "COMPLETED") {
      await prisma.interaction.createMany({
        data: [
          {
            clientId: d.client.id,
            agentId: d.agent.id,
            propertyId: d.property.id,
            type: "SHOWING",
            outcome: "POSITIVE",
            notes: "Показ объекта, клиенту всё понравилось",
            createdAt: new Date(startedAt.getTime() + 3 * DAY),
          },
          {
            clientId: d.client.id,
            agentId: d.agent.id,
            propertyId: d.property.id,
            type: "SYSTEM",
            notes: "Сделка закрыта",
            createdAt: closedAt ?? new Date(),
          },
        ],
      });
    } else if (d.stage === "CANCELLED") {
      await prisma.interaction.createMany({
        data: [
          {
            clientId: d.client.id,
            agentId: d.agent.id,
            propertyId: d.property.id,
            type: "SHOWING",
            outcome: "NEGATIVE",
            notes: "Показ объекта — клиента не устроила цена, взял паузу подумать",
            createdAt: new Date(startedAt.getTime() + 5 * DAY),
          },
          {
            clientId: d.client.id,
            agentId: d.agent.id,
            propertyId: d.property.id,
            type: "SYSTEM",
            notes: "Сделка отменена",
            createdAt: new Date(startedAt.getTime() + 10 * DAY),
          },
        ],
      });
    }
  }

  await prisma.settings.upsert({
    where: { id: "singleton" },
    update: {},
    create: { id: "singleton" },
  });

  console.log("Готово:", {
    districts: districts.length,
    agents: agents.length + 1,
    properties: createdProperties.length,
    clients: clientsData.length,
    deals: deals.length,
  });
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
