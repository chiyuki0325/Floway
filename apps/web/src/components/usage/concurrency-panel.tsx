import { useTranslation } from '../../i18n/translation';
import { EmptyStateLine } from '../ui/empty-state';
import { Panel } from '../ui/panel';

export function ConcurrencyPanel({
  records,
}: {
  records: Array<{
    hour: string;
    upstream_id: string;
    limit: number;
    samples: number;
    active_average: number;
    active_max: number;
    queued_average: number;
    queued_max: number;
  }> | null;
}) {
  const { t } = useTranslation();
  return <Panel>
    <h2 className="text-base font-semibold">{t('dashboard.usage.concurrency.title')}</h2>
    {records === null || records.length === 0 ? <EmptyStateLine>{t('dashboard.usage.concurrency.empty')}</EmptyStateLine> : (
      <div className="mt-3 overflow-x-auto">
        <table className="w-full text-sm">
          <thead><tr className="text-left">
            <th>{t('dashboard.usage.concurrency.hour')}</th>
            <th>{t('dashboard.usage.concurrency.upstream')}</th>
            <th>{t('dashboard.usage.concurrency.limit')}</th>
            <th>{t('dashboard.usage.concurrency.active')}</th>
            <th>{t('dashboard.usage.concurrency.queued')}</th>
          </tr></thead>
          <tbody>{records.map(record => <tr key={`${record.hour}-${record.upstream_id}`}>
            <td>{record.hour}</td>
            <td>{record.upstream_id}</td>
            <td>{record.limit}</td>
            <td>{record.active_average.toFixed(2)} / {record.active_max}</td>
            <td>{record.queued_average.toFixed(2)} / {record.queued_max}</td>
          </tr>)}</tbody>
        </table>
      </div>
    )}
  </Panel>;
}
