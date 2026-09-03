import { useEffect, useRef, useState } from 'react';
import {
  createChart, CrosshairMode,
} from 'lightweight-charts';
import type { Candle } from '@workspace/api-client-react';
import { useThemeStore } from '@/store/useThemeStore';

const BASE_URL = import.meta.env.BASE_URL?.replace(/\/$/, '') ?? '';

interface ChartProps {
  symbol?: string;
  interval?: string;
}

const Chart = ({ symbol, interval }: ChartProps) => {
  const chartRef = useRef<HTMLDivElement>(null);
  const [loading, setLoading] = useState(true);
  const [chartData, setChartData] = useState<Candle[]>([]);
  const theme = useThemeStore((state) => state.theme);

  useEffect(() => {
    const fetchData = async () => {
      setLoading(true);
      try {
        const response = await fetch(`${BASE_URL}/api/candles?symbol=${symbol}&interval=${interval}`);
        if (!response.ok) throw new Error(`Error fetching data: ${response.statusText}`);
        const data = await response.json();
        if (Array.isArray(data) && data.length > 0) {
          setChartData(data);
        } else {
          throw new Error('No valid data returned');
        }
      } catch (error) {
        console.error(error);
        setChartData([]);
      } finally {
        setLoading(false);
      }
    };

    if (symbol && interval) fetchData();
  }, [symbol, interval]);

  const chart = useRef<any>(null);
  const candleSeries = useRef<any>(null);

  useEffect(() => {
    if (chartRef.current) {
      chart.current = createChart(chartRef.current, {
        layout: { backgroundColor: 'transparent', textColor: theme === 'dark' ? '#ffffff' : '#000000' },
        crossHair: { mode: CrosshairMode.Normal },
      });
      candleSeries.current = chart.current.addCandlestickSeries({
        upColor: '#4fff1f',
        downColor: '#ff4976',
        borderUpColor: '#4fff1f',
        borderDownColor: '#ff4976',
        wickUpColor: '#4fff1f',
        wickDownColor: '#ff4976',
      });
    }

    return () => chart.current?.remove();
  }, [theme]);

  useEffect(() => {
    if (candleSeries.current && chartData.length > 0) {
      const seriesData = chartData.map(item => ({
        time: item.time,
        open: item.open,
        high: item.high,
        low: item.low,
        close: item.close,
      }));
      candleSeries.current.setData(seriesData);
    }
  }, [chartData]);

  return (
    <div>
      {loading ? <div>Loading...</div> : <div ref={chartRef} style={{position: 'relative', width: '100%', height: '300px'}} />}
    </div>
  );
};

export default Chart;
