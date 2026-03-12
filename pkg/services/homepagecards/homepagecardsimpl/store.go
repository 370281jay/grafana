package homepagecardsimpl

import (
	"context"

	"github.com/grafana/grafana/pkg/services/homepagecards"
)

type store interface {
	List(context.Context, *homepagecards.GetHomePageCardsQuery) ([]*homepagecards.HomePageCard, error)
	Create(context.Context, *homepagecards.CreateHomePageCardCommand) (*homepagecards.HomePageCard, error)
	Update(context.Context, *homepagecards.UpdateHomePageCardCommand) (*homepagecards.HomePageCard, error)
	Delete(context.Context, *homepagecards.DeleteHomePageCardCommand) error
}
