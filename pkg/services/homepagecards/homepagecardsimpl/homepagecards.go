package homepagecardsimpl

import (
	"context"

	"github.com/grafana/grafana/pkg/infra/db"
	"github.com/grafana/grafana/pkg/services/homepagecards"
)

type Service struct {
	store store
}

func ProvideService(db db.DB) homepagecards.Service {
	return &Service{
		store: &sqlStore{db: db},
	}
}

func (s *Service) List(ctx context.Context, query *homepagecards.GetHomePageCardsQuery) ([]*homepagecards.HomePageCard, error) {
	return s.store.List(ctx, query)
}

func (s *Service) Create(ctx context.Context, cmd *homepagecards.CreateHomePageCardCommand) (*homepagecards.HomePageCard, error) {
	if err := cmd.Validate(); err != nil {
		return nil, err
	}

	return s.store.Create(ctx, cmd)
}

func (s *Service) Update(ctx context.Context, cmd *homepagecards.UpdateHomePageCardCommand) (*homepagecards.HomePageCard, error) {
	if err := cmd.Validate(); err != nil {
		return nil, err
	}

	return s.store.Update(ctx, cmd)
}

func (s *Service) Delete(ctx context.Context, cmd *homepagecards.DeleteHomePageCardCommand) error {
	if err := cmd.Validate(); err != nil {
		return err
	}

	return s.store.Delete(ctx, cmd)
}
