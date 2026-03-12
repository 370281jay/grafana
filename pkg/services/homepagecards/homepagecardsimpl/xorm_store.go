package homepagecardsimpl

import (
	"context"

	"github.com/grafana/grafana/pkg/infra/db"
	"github.com/grafana/grafana/pkg/services/homepagecards"
)

type sqlStore struct {
	db db.DB
}

func (s *sqlStore) List(ctx context.Context, query *homepagecards.GetHomePageCardsQuery) ([]*homepagecards.HomePageCard, error) {
	var cards []*homepagecards.HomePageCard
	err := s.db.WithDbSession(ctx, func(sess *db.Session) error {
		return sess.Where("org_id = ?", query.OrgID).Asc("id").Find(&cards)
	})
	if err != nil {
		return nil, err
	}

	return cards, nil
}

func (s *sqlStore) Create(ctx context.Context, cmd *homepagecards.CreateHomePageCardCommand) (*homepagecards.HomePageCard, error) {
	entity := &homepagecards.HomePageCard{
		OrgID:        cmd.OrgID,
		DeviceMAC:    cmd.DeviceMAC,
		CardName:     cmd.CardName,
		DashboardUID: cmd.DashboardUID,
	}

	err := s.db.WithTransactionalDbSession(ctx, func(sess *db.Session) error {
		_, err := sess.Insert(entity)
		return err
	})
	if err != nil {
		return nil, err
	}

	return entity, nil
}

func (s *sqlStore) Update(ctx context.Context, cmd *homepagecards.UpdateHomePageCardCommand) (*homepagecards.HomePageCard, error) {
	entity := &homepagecards.HomePageCard{}
	err := s.db.WithTransactionalDbSession(ctx, func(sess *db.Session) error {
		exists, err := sess.Where("id = ? AND org_id = ?", cmd.ID, cmd.OrgID).Get(entity)
		if err != nil {
			return err
		}
		if !exists {
			return homepagecards.ErrHomePageCardNotFound
		}

		entity.DeviceMAC = cmd.DeviceMAC
		entity.CardName = cmd.CardName
		entity.DashboardUID = cmd.DashboardUID

		_, err = sess.ID(entity.ID).AllCols().Update(entity)
		return err
	})
	if err != nil {
		return nil, err
	}

	return entity, nil
}

func (s *sqlStore) Delete(ctx context.Context, cmd *homepagecards.DeleteHomePageCardCommand) error {
	return s.db.WithTransactionalDbSession(ctx, func(sess *db.Session) error {
		entity := &homepagecards.HomePageCard{}
		exists, err := sess.Where("id = ? AND org_id = ?", cmd.ID, cmd.OrgID).Get(entity)
		if err != nil {
			return err
		}
		if !exists {
			return homepagecards.ErrHomePageCardNotFound
		}

		_, err = sess.ID(entity.ID).Delete(entity)
		if err != nil {
			return err
		}

		return nil
	})
}
