import { db } from '../db/index.js';

async function main() {
  const date = '2026-09-26';
  
  // Let us inspect the 1201 orders in current_work_orders on 2026-09-26
  const orders = db.prepare('SELECT * FROM current_work_orders WHERE work_date = ?').all(date);
  console.log('Total orders:', orders.length);

  // Reconstruct workGroups as allocation.js does
  const accGroupMap = new Map();
  const workGroups = [];

  for (const ord of orders) {
    const isPending = (ord.status || '').toLowerCase().includes('pending') || (ord.source_type === 'PENDING');
    const stream = isPending ? 'PENDING' : 'NEW';
    const groupKey = `${ord.account.toLowerCase()}|${stream}`;

    if (!accGroupMap.has(groupKey)) {
      const grp = {
        account: ord.account,
        stream,
        has_fast_track: false,
        has_delayed: false,
        delayed_count: 0,
        orders: []
      };
      accGroupMap.set(groupKey, grp);
      workGroups.push(grp);
    }
    const targetGrp = accGroupMap.get(groupKey);
    const isDelayed = !isPending && (
      (ord.priority === 'FAST_TRACK') ||
      (ord.priority === 'DELAYED') ||
      (ord.priority === 'DELAYED_NEW') ||
      (ord.priority === 'OVERDUE') ||
      (ord.order_date && ord.order_date < date)
    );
    if (ord.priority === 'FAST_TRACK') targetGrp.has_fast_track = true;
    if (isDelayed) {
      targetGrp.has_delayed = true;
      targetGrp.delayed_count = (targetGrp.delayed_count || 0) + 1;
    }
    targetGrp.orders.push(ord);
  }

  workGroups.sort((a, b) => {
    const rankA = (a.stream === 'NEW') ? (a.has_delayed || a.has_fast_track ? 1 : 2) : (a.has_fast_track ? 3 : 4);
    const rankB = (b.stream === 'NEW') ? (b.has_delayed || b.has_fast_track ? 1 : 2) : (b.has_fast_track ? 3 : 4);
    if (rankA !== rankB) return rankA - rankB;
    if ((b.delayed_count || 0) !== (a.delayed_count || 0)) {
      return (b.delayed_count || 0) - (a.delayed_count || 0);
    }
    if (b.orders.length !== a.orders.length) {
      return b.orders.length - a.orders.length;
    }
    return a.account.localeCompare(b.account);
  });

  console.log(`Total workGroups: ${workGroups.length}`);
  const newGroups = workGroups.filter(g => g.stream === 'NEW');
  const pendGroups = workGroups.filter(g => g.stream === 'PENDING');
  console.log(`NEW groups: ${newGroups.length}, total NEW orders in groups: ${newGroups.reduce((s, g) => s + g.orders.length, 0)}`);
  console.log(`PENDING groups: ${pendGroups.length}, total PENDING orders in groups: ${pendGroups.reduce((s, g) => s + g.orders.length, 0)}`);

  console.log('\nAll NEW groups in order:');
  for (let i = 0; i < newGroups.length; i++) {
    const g = newGroups[i];
    console.log(`${i + 1}. Account: "${g.account}", Orders: ${g.orders.length}, Delayed: ${g.delayed_count}, HasDelayed: ${g.has_delayed}`);
  }
}

main().catch(console.error);
