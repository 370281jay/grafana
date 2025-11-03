import { Box, Button } from '@grafana/ui';
import { Page } from 'app/core/components/Page/Page';

export function HomePage() {
  return (
    <Page navId="home">
      <Box display="flex" direction="column" alignItems="center" justifyContent="center" paddingY={8}>
        <h1 style={{ fontSize: '48px', marginBottom: '16px' }}>
          欢迎来到惠康可视化平台
        </h1>
        <p style={{ fontSize: '18px', color: 'rgba(0, 0, 0, 0.6)', marginBottom: '32px' }}>
          强大的数据可视化和监控解决方案
        </p>
        <Box marginTop={4} display="flex" gap={2}>
          <Button variant="primary" size="lg">
            开始使用
          </Button>
          <Button variant="secondary" size="lg">
            了解更多
          </Button>
        </Box>
      </Box>
    </Page>
  );
}
